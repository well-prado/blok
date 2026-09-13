/**
 * What a generated project actually gets for its selected JavaScript target
 * (#942: "each generated project installs, type-checks, builds, tests, and
 * starts using its selected runtime", and "generated deployment/container
 * metadata uses the selected runtime and a pinned supported version").
 *
 * The scaffold smoke proves these commands RUN; this pins what they ARE, so a
 * refactor cannot quietly put `bun` back into a Node.js project's image.
 */

import { describe, expect, it } from "vitest";
import { JAVASCRIPT_RUNTIME_DEFINITIONS } from "../../src/services/runtime-detector.js";
import {
	generateExampleTest,
	generateJavaScriptScripts,
	generateJavaScriptWorkerSupervisord,
	javaScriptTestCommand,
	javaScriptWorkerCommand,
	withJavaScriptEngine,
} from "../../src/services/runtime-setup.js";

const DOCKERFILE = [
	"FROM oven/bun:1 AS base",
	"WORKDIR /usr/src/app",
	"",
	"FROM oven/bun:1-slim AS release",
	"COPY --from=prerelease /usr/src/app/dist dist",
	"",
	'ENTRYPOINT [ "bun", "run", "dist/index.js" ]',
].join("\n");

describe("generated scripts per execution target", () => {
	it("runs the selected engine's own test runner", () => {
		expect(javaScriptTestCommand("node")).toContain("node --test");
		expect(javaScriptTestCommand("bun")).toContain("bun test");
		expect(javaScriptTestCommand("deno")).toContain("deno test");
		// Deno needs node_modules resolution; without it the built nodes' bare
		// specifiers do not resolve and the suite fails for the wrong reason.
		expect(javaScriptTestCommand("deno")).toContain("--node-modules-dir=manual");
	});

	it("builds and typechecks with tsc whatever the target", () => {
		for (const def of JAVASCRIPT_RUNTIME_DEFINITIONS) {
			const scripts = generateJavaScriptScripts(def.target, "http", def.defaultGrpcPort);
			expect(scripts.typecheck, def.target).toBe("tsc --noEmit");
		}
	});

	it("starts the orchestrator under the target, except Deno which the runner is not hosted on", () => {
		expect(generateJavaScriptScripts("node", "http", 10012).start).toBe("node dist/triggers/http/index.js");
		expect(generateJavaScriptScripts("bun", "http", 10013).start).toBe("bun dist/triggers/http/index.js");
		expect(generateJavaScriptScripts("deno", "http", 10014).start).toBe("node dist/triggers/http/index.js");
	});

	it("boots the worker under the selected engine, on that engine's port", () => {
		expect(javaScriptWorkerCommand("node", 10012)).toBe("node node_modules/@blokjs/runtime-worker/dist/bin.js");
		expect(javaScriptWorkerCommand("bun", 10013)).toBe("bun node_modules/@blokjs/runtime-worker/dist/bin.js");
		const deno = javaScriptWorkerCommand("deno", 10014);
		// Least privilege: one bound port, project read, env. Never --allow-all,
		// never --allow-write, never --allow-run, never --allow-ffi.
		expect(deno).toContain("--allow-net=127.0.0.1:10014,localhost:10014");
		expect(deno).toContain("--allow-read=.");
		expect(deno).toContain("--allow-env");
		for (const forbidden of ["--allow-all", "--allow-write", "--allow-run", "--allow-ffi"]) {
			expect(deno, forbidden).not.toContain(forbidden);
		}
	});

	it("ships a test that every engine can run unchanged", () => {
		const test = generateExampleTest("deno");
		// `node:test` + `node:assert` is the only test spelling Node.js, Bun and
		// Deno all run natively; a TypeScript test would need a Node that strips
		// types, and a framework would pick an engine for the user.
		expect(test).toContain('from "node:test"');
		expect(test).toContain('from "node:assert/strict"');
		expect(test).not.toContain("vitest");
		// It loads the BUILT registry — the same load the worker performs.
		expect(test).toContain("../dist/Nodes.js");
	});
});

describe("generated deployment metadata", () => {
	it("supervises the worker under the selected engine, pinned", () => {
		for (const def of JAVASCRIPT_RUNTIME_DEFINITIONS) {
			const program = generateJavaScriptWorkerSupervisord(def.target, def.defaultGrpcPort, def.pinnedVersion);
			expect(program, def.target).toContain("[program:javascript_worker]");
			expect(program, def.target).toContain(`command=${javaScriptWorkerCommand(def.target, def.defaultGrpcPort)}`);
			expect(program, def.target).toContain(`Pinned engine: ${def.target} ${def.pinnedVersion}`);
			// Supervised means supervised: the language sidecars' own shape.
			expect(program, def.target).toContain("autostart=true");
			expect(program, def.target).toContain("autorestart=true");
		}
	});

	it("adds a pinned engine layer for a non-Bun target and rewrites the entrypoint", () => {
		const deno = JAVASCRIPT_RUNTIME_DEFINITIONS.find((d) => d.target === "deno");
		const out = withJavaScriptEngine(
			DOCKERFILE,
			"deno",
			deno?.dockerProvision as string,
			"dist/triggers/http/index.js",
		);
		expect(out).toContain("COPY --from=denoland/deno:bin-2.7.5 /deno /usr/local/bin/deno");
		// Inserted INTO the release stage, not before it.
		expect(out.indexOf("FROM oven/bun:1-slim AS release")).toBeLessThan(out.indexOf("denoland/deno:bin"));
		// The inherited entrypoint named the wrong engine AND the wrong path.
		expect(out).toContain('ENTRYPOINT [ "node", "dist/triggers/http/index.js" ]');
		expect(out).not.toContain('"dist/index.js"');
	});

	it("leaves a Bun project's base image alone but still fixes the entrypoint path", () => {
		const out = withJavaScriptEngine(DOCKERFILE, "bun", "", "dist/triggers/http/index.js");
		// No engine layer added — Bun is already the base image.
		expect(out).toBe(DOCKERFILE.replace(/^ENTRYPOINT.*$/m, 'ENTRYPOINT [ "bun", "dist/triggers/http/index.js" ]'));
	});

	it("is idempotent — re-running never stacks engine layers", () => {
		const node = JAVASCRIPT_RUNTIME_DEFINITIONS.find((d) => d.target === "node");
		const once = withJavaScriptEngine(DOCKERFILE, "node", node?.dockerProvision as string, "dist/x.js");
		const twice = withJavaScriptEngine(once, "node", node?.dockerProvision as string, "dist/x.js");
		expect(twice).toBe(once);
	});
});
