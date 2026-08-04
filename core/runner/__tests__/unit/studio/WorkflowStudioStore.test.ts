import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkflowStudioConfig, writeWorkflowStudioConfig } from "../../../src/studio/WorkflowStudioStore";

describe("WorkflowStudioStore", () => {
	let projectRoot: string;
	let outsideRoot: string;
	let sourcePath: string;

	const config = (x = 10) => ({
		schemaVersion: 1 as const,
		workflow: "order-intake",
		nodes: { validate: { x, y: 20 } },
	});

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "blok-studio-project-"));
		outsideRoot = await mkdtemp(join(tmpdir(), "blok-studio-outside-"));
		sourcePath = join(projectRoot, "order-intake.ts");
		await writeFile(sourcePath, "export default {};\n");
	});

	afterEach(async () => {
		await Promise.all([
			rm(projectRoot, { recursive: true, force: true }),
			rm(outsideRoot, { recursive: true, force: true }),
		]);
	});

	it("creates, reads, and updates the sibling sidecar with etags", async () => {
		const created = await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(), null);
		const sidecarPath = join(projectRoot, "order-intake.studio.json");

		expect(created.etag).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(await readFile(sidecarPath, "utf8"))).toMatchObject(config());
		expect(await readWorkflowStudioConfig(sourcePath, projectRoot, "order-intake")).toEqual(created);

		const updated = await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(30), created.etag);
		expect(updated.config?.nodes.validate.x).toBe(30);
		expect(updated.etag).not.toBe(created.etag);
	});

	it("rejects a stale etag without modifying the file", async () => {
		await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(), null);
		const sidecarPath = join(projectRoot, "order-intake.studio.json");
		const before = await readFile(sidecarPath, "utf8");

		await expect(
			writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(99), "stale"),
		).rejects.toMatchObject({ statusCode: 409, code: "stale_etag" });
		expect(await readFile(sidecarPath, "utf8")).toBe(before);
	});

	it("rejects traversal, outside-root sources, and symlinks that escape the project", async () => {
		const outsideSource = join(outsideRoot, "outside.ts");
		await writeFile(outsideSource, "export default {};\n");
		const traversingPath = join(projectRoot, "nested", "..", "..", basename(outsideRoot), "outside.ts");
		const linkedSource = join(projectRoot, "linked.ts");
		await symlink(outsideSource, linkedSource);

		for (const unsafePath of [outsideSource, traversingPath, linkedSource]) {
			await expect(readWorkflowStudioConfig(unsafePath, projectRoot, "order-intake")).rejects.toMatchObject({
				statusCode: 403,
			});
		}
	});

	it("does not follow a sidecar symlink", async () => {
		const outsideTarget = join(outsideRoot, "target.json");
		await writeFile(outsideTarget, JSON.stringify(config()));
		await symlink(outsideTarget, join(projectRoot, "order-intake.studio.json"));

		await expect(readWorkflowStudioConfig(sourcePath, projectRoot, "order-intake")).rejects.toMatchObject({
			statusCode: 403,
			code: "sidecar_symlink",
		});
		await expect(
			writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(99), null),
		).rejects.toMatchObject({ statusCode: 403, code: "sidecar_symlink" });
		expect(JSON.parse(await readFile(outsideTarget, "utf8"))).toEqual(config());
	});

	it("rejects a source path that is not a file", async () => {
		const directorySource = join(projectRoot, "directory.ts");
		await mkdir(directorySource);
		await expect(readWorkflowStudioConfig(directorySource, projectRoot, "order-intake")).rejects.toMatchObject({
			statusCode: 409,
			code: "non_file_source",
		});
	});

	it("validates before writing and preserves the last valid file", async () => {
		await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(), null);
		const sidecarPath = join(projectRoot, "order-intake.studio.json");
		const before = await readFile(sidecarPath, "utf8");

		await expect(
			writeWorkflowStudioConfig(
				sourcePath,
				projectRoot,
				"order-intake",
				{ ...config(), nodes: { validate: { x: Number.POSITIVE_INFINITY, y: 0 } } },
				null,
			),
		).rejects.toMatchObject({ statusCode: 400, code: "invalid_config" });
		expect(await readFile(sidecarPath, "utf8")).toBe(before);
	});
});
