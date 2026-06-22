import { describe, expect, it } from "vitest";
import {
	ensureRuntimeGitignore,
	rewriteRuntimeEnvBlock,
	rewriteSupervisordRuntimes,
	withRuntime,
	withoutRuntime,
} from "../../src/services/runtime-mutations.js";
import type { ProjectConfig, RuntimeConfig, TriggerConfig } from "../../src/services/runtime-setup.js";

const rc = (kind: string, grpcPort: number, label = kind): RuntimeConfig => ({
	port: grpcPort - 1000,
	grpcPort,
	startCmd: `start-${kind}`,
	cwd: `.blok/runtimes/${kind}`,
	kind,
	label,
	transport: "grpc",
});

const httpTrigger: TriggerConfig = {
	kind: "http",
	label: "HTTP Trigger",
	port: 4000,
	entryPoint: "src/triggers/http/index.ts",
	startCmd: "bun run src/triggers/http/index.ts",
};

describe("withRuntime / withoutRuntime", () => {
	it("adds a runtime while preserving triggers + siblings", () => {
		const cfg: ProjectConfig = { triggers: { http: httpTrigger }, runtimes: { go: rc("go", 10001) } };
		const next = withRuntime(cfg, rc("python3", 10007));
		expect(Object.keys(next.runtimes ?? {})).toEqual(["go", "python3"]);
		expect(next.triggers).toEqual(cfg.triggers);
	});

	it("replaces an existing runtime of the same kind", () => {
		const next = withRuntime({ runtimes: { go: rc("go", 10001) } }, rc("go", 12345));
		expect(next.runtimes?.go.grpcPort).toBe(12345);
	});

	it("removes a runtime, keeping siblings + triggers", () => {
		const cfg: ProjectConfig = {
			triggers: { http: httpTrigger },
			runtimes: { go: rc("go", 10001), rust: rc("rust", 10002) },
		};
		const next = withoutRuntime(cfg, "go");
		expect(Object.keys(next.runtimes ?? {})).toEqual(["rust"]);
		expect(next.triggers).toBeDefined();
	});

	it("drops the runtimes key when removing the last runtime", () => {
		const next = withoutRuntime({ triggers: { http: httpTrigger }, runtimes: { go: rc("go", 10001) } }, "go");
		expect(next.runtimes).toBeUndefined();
		expect(JSON.stringify(next)).not.toContain("runtimes");
	});

	it("is a no-op (same reference) when the runtime is absent", () => {
		const cfg: ProjectConfig = { runtimes: { go: rc("go", 10001) } };
		expect(withoutRuntime(cfg, "rust")).toBe(cfg);
	});
});

describe("rewriteRuntimeEnvBlock", () => {
	it("adds a runtime block to empty content", () => {
		const out = rewriteRuntimeEnvBlock("", [rc("go", 10001)]);
		expect(out).toContain("RUNTIME_GO_GRPC_PORT=10001");
		expect(out).toContain("BLOK_TRANSPORT=grpc");
	});

	it("replaces the block without duplicating header/BLOK_TRANSPORT and preserves user vars", () => {
		const first = rewriteRuntimeEnvBlock("API_KEY=secret\n", [rc("go", 10001)]);
		const second = rewriteRuntimeEnvBlock(first, [rc("go", 10001), rc("python3", 10007)]);
		expect(second.match(/# Runtimes \(auto-configured by blokctl\)/g)?.length).toBe(1);
		expect(second.match(/BLOK_TRANSPORT=grpc/g)?.length).toBe(1);
		expect(second).toContain("RUNTIME_PYTHON3_GRPC_PORT=10007");
		expect(second).toContain("API_KEY=secret");
	});

	it("removes the entire block when no runtimes remain (keeps user vars)", () => {
		const withGo = rewriteRuntimeEnvBlock("API_KEY=secret\n", [rc("go", 10001)]);
		const cleared = rewriteRuntimeEnvBlock(withGo, []);
		expect(cleared).not.toContain("RUNTIME_");
		expect(cleared).not.toContain("BLOK_TRANSPORT");
		expect(cleared).toContain("API_KEY=secret");
	});

	it("uses the CSHARP env key for csharp", () => {
		expect(rewriteRuntimeEnvBlock("", [rc("csharp", 10004)])).toContain("RUNTIME_CSHARP_GRPC_PORT=10004");
	});
});

describe("rewriteSupervisordRuntimes", () => {
	const base = "[supervisord]\nnodaemon=true\n\n[program:http_trigger]\ncommand=bun run x\ndirectory=/app\n";

	it("appends a runtime block while keeping [supervisord] + trigger programs", () => {
		const out = rewriteSupervisordRuntimes(base, [rc("go", 10001)]);
		expect(out).toContain("[program:http_trigger]");
		expect(out).toContain("[program:go_runtime]");
		expect(out).toContain('GRPC_PORT="10001"');
	});

	it("removes a runtime block when it's gone, keeping triggers", () => {
		const withGo = rewriteSupervisordRuntimes(base, [rc("go", 10001)]);
		const cleared = rewriteSupervisordRuntimes(withGo, []);
		expect(cleared).not.toContain("[program:go_runtime]");
		expect(cleared).toContain("[program:http_trigger]");
	});

	it("replaces rather than appends on repeated rewrites", () => {
		const a = rewriteSupervisordRuntimes(base, [rc("go", 10001)]);
		const b = rewriteSupervisordRuntimes(a, [rc("go", 10001)]);
		expect(b.match(/\[program:go_runtime\]/g)?.length).toBe(1);
	});
});

describe("ensureRuntimeGitignore", () => {
	it("appends missing artifact globs", () => {
		expect(ensureRuntimeGitignore("node_modules\n")).toContain(".blok/runtimes/**/target/");
	});

	it("is idempotent", () => {
		const once = ensureRuntimeGitignore("node_modules\n");
		expect(ensureRuntimeGitignore(once)).toBe(once);
	});

	it("no-ops when .blok/ is ignored wholesale", () => {
		const content = "node_modules\n.blok/\n";
		expect(ensureRuntimeGitignore(content)).toBe(content);
	});
});
