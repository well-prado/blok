import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tmpDir: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	vi.resetModules();
	if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

describe("install node redirect", () => {
	it("points users at direct imports instead of Nodes.ts patching", async () => {
		const { nodeInstallHint } = await import("../../src/commands/install/node.js");

		expect(nodeInstallHint("stripeCharge", "@acme/stripe-charge")).toContain(
			'import stripeCharge from "@acme/stripe-charge";',
		);
		expect(nodeInstallHint("stripeCharge", "@acme/stripe-charge")).toContain('step("id", stripeCharge, inputs)');
		expect(nodeInstallHint("stripeCharge", "@acme/stripe-charge")).toContain("Nodes.ts registration is deprecated");
	});

	it("installs after Nodes.ts deletion and still warns with the direct-import path", async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-install-node-"));
		await fsp.writeFile(path.join(tmpDir, "package.json"), "{}\n");

		const warn = vi.fn();
		const info = vi.fn();
		const exec = vi.fn((_cmd, _opts, cb) => cb(null, { stdout: "installed\n", stderr: "" }));

		vi.doMock("node:child_process", () => ({ default: { exec }, exec }));
		vi.doMock("@clack/prompts", () => ({
			log: { info, warn },
			select: vi.fn(),
			spinner: () => ({
				error: vi.fn(),
				message: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
			}),
		}));
		vi.doMock("../../src/services/local-token-manager.js", () => ({
			tokenManager: { getToken: () => "token" },
		}));
		vi.doMock("../../src/services/non-interactive.js", () => ({
			isNonInteractive: () => true,
		}));
		vi.doMock("../../src/services/package-manager.js", () => ({
			manager: {
				getAvailableManagers: async () => ["npm"],
				getManager: async () => ({
					INSTALL_NODE: ({ node }: { node: string }) => `install ${node}`,
				}),
			},
		}));
		vi.doMock("../../src/services/registry-manager.js", () => ({
			registryManager: {
				getRegistryToken: async () => ({
					namespace: "blok",
					token: "registry-token",
					url: "registry.example.test",
				}),
			},
		}));

		const { install } = await import("../../src/commands/install/node.js");
		await install({ directory: tmpDir, node: "stripe-charge", packageManager: "npm" });

		expect(exec).toHaveBeenCalledOnce();
		expect(info).toHaveBeenCalledWith("installed\n");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('import stripeCharge from "@blok/stripe-charge";'));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('step("id", stripeCharge, inputs)'));
		await expect(fsp.stat(path.join(tmpDir, "src/Nodes.ts"))).rejects.toThrow();
		await expect(fsp.stat(path.join(tmpDir, ".npmrc"))).rejects.toThrow();
	});
});
