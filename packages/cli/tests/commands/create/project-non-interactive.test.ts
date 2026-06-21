import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject } from "../../../src/commands/create/project";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

describe("create project (non-interactive)", () => {
	beforeEach(() => {
		setNonInteractive(true);
	});

	afterEach(() => {
		setNonInteractive(false);
	});

	it("should not throw when name is provided in non-interactive mode", async () => {
		// In non-interactive mode with a name, createProject should resolve all prompts
		// via defaults and not hang waiting for interactive input
		expect(async () => await createProject({ name: "test-ni-project" })).not.toThrow();
	});

	it("should throw when name is missing in non-interactive mode", async () => {
		await expect(createProject({})).rejects.toThrow("Missing required flag --name (non-interactive mode)");
	});

	it("should accept trigger flag in non-interactive mode", async () => {
		expect(async () => await createProject({ name: "test-ni-trigger", trigger: "http" })).not.toThrow();
	});

	it("should accept runtimes flag in non-interactive mode", async () => {
		expect(async () => await createProject({ name: "test-ni-runtimes", runtimes: "node" })).not.toThrow();
	});

	it("should accept package-manager flag in non-interactive mode", async () => {
		expect(async () => await createProject({ name: "test-ni-pm", packageManager: "bun" })).not.toThrow();
	});

	// Bug 02: a worker scaffold with no --queue-provider must resolve without
	// throwing (no broker is hardcoded → in-memory default boots clean). The
	// adapter/env/dep substance is asserted deterministically in
	// worker-scaffold.test.ts; this guards the non-interactive entrypoint.
	it("should accept http,worker triggers without a queue-provider", async () => {
		expect(async () => await createProject({ name: "test-ni-http-worker", triggers: "http,worker" })).not.toThrow();
	});
});
