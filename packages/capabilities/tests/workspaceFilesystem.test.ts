import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	WorkspaceFilesystemCapability,
	workspaceFilesystemAuthority,
	workspaceFilesystemManifest,
	workspaceRelativePath,
} from "../src";

const roots: string[] = [];

async function makeCapability(options: Partial<ConstructorParameters<typeof WorkspaceFilesystemCapability>[0]> = {}) {
	const root = await mkdtemp(join(tmpdir(), "blok-workspace-fs-"));
	roots.push(root);
	return {
		root,
		capability: new WorkspaceFilesystemCapability({ roots: [{ id: "repo", path: root }], ...options }),
	};
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("workspace filesystem capability", () => {
	it("canonicalizes roots, rejects traversal and does not expose host paths", async () => {
		const { root, capability } = await makeCapability();
		await writeFile(join(root, "hello.txt"), "hello");

		await expect(capability.read({ workspaceId: "repo", path: "hello.txt" })).resolves.toMatchObject({
			path: "hello.txt",
			content: "hello",
			version: expect.stringMatching(/^sha256:/),
		});
		await expect(capability.read({ workspaceId: "repo", path: "../hello.txt" })).rejects.toMatchObject({
			code: "WORKSPACE_FS_PATH_ESCAPE",
		});
		await expect(capability.read({ workspaceId: "repo", path: "C:\\secret.txt" })).rejects.toMatchObject({
			code: "WORKSPACE_FS_PATH_ESCAPE",
		});
		const metadata = await capability.metadata({ workspaceId: "repo", path: "hello.txt" });
		expect(metadata).not.toHaveProperty("root");
		expect(JSON.stringify(metadata)).not.toContain(root);
	});

	it("blocks symlink and hardlink escapes", async () => {
		if (process.platform === "win32") return;
		const { root } = await makeCapability();
		const outside = await mkdtemp(join(tmpdir(), "blok-workspace-outside-"));
		roots.push(outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		await expect(
			new WorkspaceFilesystemCapability({ roots: [{ id: "repo", path: root }] }).read({
				workspaceId: "repo",
				path: "link.txt",
			}),
		).rejects.toMatchObject({ code: "WORKSPACE_FS_SYMLINK_DISALLOWED" });

		await writeFile(join(root, "normal.txt"), "not secret");
		await import("node:fs/promises").then(({ link }) => link(join(outside, "secret.txt"), join(root, "hardlink.txt")));
		await expect(
			new WorkspaceFilesystemCapability({ roots: [{ id: "repo", path: root }] }).read({
				workspaceId: "repo",
				path: "hardlink.txt",
			}),
		).rejects.toMatchObject({ code: "WORKSPACE_FS_HARDLINK_DISALLOWED" });
	});

	it("returns stable binary and invalid-encoding errors", async () => {
		const { root, capability } = await makeCapability();
		await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
		await expect(capability.read({ workspaceId: "repo", path: "binary.bin" })).rejects.toMatchObject({
			code: "WORKSPACE_FS_BINARY_FILE",
		});
		await expect(
			capability.read({ workspaceId: "repo", path: "binary.bin", encoding: "bytes" }),
		).resolves.toMatchObject({
			content: expect.any(Uint8Array),
		});
		await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
		await expect(capability.read({ workspaceId: "repo", path: "invalid.txt" })).rejects.toMatchObject({
			code: "WORKSPACE_FS_INVALID_ENCODING",
		});
	});

	it("bounds lines, list entries, and search matches", async () => {
		const { root, capability } = await makeCapability({
			limits: { maxLines: 2, maxListFiles: 1, maxSearchMatches: 1 },
		});
		await mkdir(join(root, "src"));
		await writeFile(join(root, "a.txt"), "needle\nneedle\nthird");
		await writeFile(join(root, "src", "b.txt"), "needle");
		await expect(
			capability.read({ workspaceId: "repo", path: "a.txt", startLine: 1, endLine: 3 }),
		).rejects.toMatchObject({
			code: "WORKSPACE_FS_LINE_LIMIT",
		});
		await expect(capability.list({ workspaceId: "repo", path: ".", recursive: true })).resolves.toMatchObject({
			truncated: true,
			entries: expect.any(Array),
		});
		await expect(capability.search({ workspaceId: "repo", path: ".", query: "needle" })).resolves.toMatchObject({
			truncated: true,
			matches: [{ path: "a.txt", line: 1, column: 1 }],
		});
	});

	it("requires an expected version and atomically replaces unchanged files", async () => {
		const { root, capability } = await makeCapability();
		const target = join(root, "new.txt");
		await expect(capability.write({ workspaceId: "repo", path: "new.txt", content: "one" })).resolves.toMatchObject({
			created: true,
			version: expect.stringMatching(/^sha256:/),
		});
		const current = await capability.read({ workspaceId: "repo", path: "new.txt" });
		await expect(capability.write({ workspaceId: "repo", path: "new.txt", content: "two" })).rejects.toMatchObject({
			code: "WORKSPACE_FS_VERSION_REQUIRED",
		});
		await expect(
			capability.write({
				workspaceId: "repo",
				path: "new.txt",
				content: "two",
				expectedVersion: `sha256:${"0".repeat(64)}`,
			}),
		).rejects.toMatchObject({ code: "WORKSPACE_FS_VERSION_CONFLICT" });
		await expect(
			capability.write({ workspaceId: "repo", path: "new.txt", content: "two", expectedVersion: current.version }),
		).resolves.toMatchObject({ created: false });
		expect(await readFile(target, "utf8")).toBe("two");
		await expect(
			capability.patch({
				workspaceId: "repo",
				path: "new.txt",
				patches: [{ start: 0, end: 3, replacement: "three" }],
				expectedVersion: (await capability.read({ workspaceId: "repo", path: "new.txt" })).version,
			}),
		).resolves.toMatchObject({
			bytesWritten: 5,
		});
	});

	it("uses separate shared manifests and policy decisions for each effect", async () => {
		const decisions: string[] = [];
		const { root } = await makeCapability();
		await writeFile(join(root, "a.txt"), "a");
		const fs = new WorkspaceFilesystemCapability({
			roots: [{ id: "repo", path: root }],
			policy: {
				provider: {
					evaluate: async (request) => {
						const extra = request as typeof request & { operation?: string };
						decisions.push(extra.operation ?? "missing");
						return {
							decision: { kind: "allow", id: "decision", reasonCode: "test", policyVersion: "test-v1" },
							matchedRules: [],
						};
					},
				},
				principal: { id: "agent", kind: "agent" },
				session: { id: "session" },
				turn: { id: "turn" },
				policyVersion: "test-v1",
				workflow: { name: "coding" },
				step: { id: "filesystem" },
				layers: [],
			},
		});
		await fs.read({ workspaceId: "repo", path: "a.txt" });
		await fs.search({ workspaceId: "repo", path: ".", query: "a" });
		expect(decisions).toEqual(["read", "search"]);
		expect(workspaceFilesystemManifest("read").capabilities).toEqual(["fs.workspace.read"]);
		expect(workspaceFilesystemManifest("write").capabilities).toEqual(["fs.workspace.write"]);
		expect(workspaceFilesystemAuthority("search", "repo").fragments).toEqual({ workspace: "repo" });
	});

	it("emits bounded watch events and supports cancellation", async () => {
		const { root, capability } = await makeCapability();
		const iterator = capability.watch({
			workspaceId: "repo",
			path: ".",
			debounceMs: 5,
			maxEvents: 1,
			maxDurationMs: 5_000,
		});
		const next = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await writeFile(join(root, "watched.txt"), "change");
		await expect(next).resolves.toMatchObject({ value: { path: "watched.txt", requiresRescan: false }, done: false });
		await iterator.return?.();

		const controller = new AbortController();
		const cancelled = capability.watch({
			workspaceId: "repo",
			path: ".",
			signal: controller.signal,
			maxDurationMs: 5_000,
		});
		const pending = cancelled.next();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_FS_CANCELLED" });
	});
});

describe("workspace filesystem platform fixture", () => {
	it("keeps portable escape cases stable across host platforms", () => {
		expect(() => workspaceRelativePath("\\\\server\\share\\secret")).toThrowError(
			expect.objectContaining({ code: "WORKSPACE_FS_PATH_ESCAPE" }),
		);
	});
});
