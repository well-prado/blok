import fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted above imports by vitest) ------------------------------

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	note: vi.fn(),
	cancel: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
	confirm: vi.fn(async () => true),
	isCancel: () => false,
}));

vi.mock("../../../src/services/runtime-detector.js", async (orig) => {
	const actual = await orig<typeof import("../../../src/services/runtime-detector.js")>();
	return {
		...actual,
		// Pretend every toolchain is present so tests don't depend on the host.
		detectRuntimes: vi.fn(async () =>
			actual.getAllRuntimeDefinitions().map((d) => ({ ...d, available: true, version: "1.0.0" })),
		),
	};
});

vi.mock("../../../src/services/runtime-setup.js", async (orig) => {
	const actual = await orig<typeof import("../../../src/services/runtime-setup.js")>();
	return {
		...actual,
		// Skip the real SDK copy + heavy build; just lay down the dirs the
		// command's existence checks expect and return a plausible config.
		setupRuntime: vi.fn(
			async (
				rt: { kind: string; label: string; defaultPort: number; defaultGrpcPort: number },
				_src: string,
				projectDir: string,
			) => {
				fs.mkdirSync(path.join(projectDir, ".blok", "runtimes", rt.kind), { recursive: true });
				fs.mkdirSync(path.join(projectDir, "runtimes", rt.kind, "nodes"), { recursive: true });
				return {
					port: rt.defaultPort,
					grpcPort: rt.defaultGrpcPort,
					startCmd: `start-${rt.kind}`,
					cwd: `.blok/runtimes/${rt.kind}`,
					kind: rt.kind,
					label: rt.label,
					version: "1.0.0",
					requiredVersion: ">=1.0.0",
					transport: "grpc" as const,
				};
			},
		),
	};
});

import { runtimeAdd } from "../../../src/commands/runtime/add.js";
import { runtimeList } from "../../../src/commands/runtime/list.js";
import { runtimeRemove } from "../../../src/commands/runtime/remove.js";
import { assertSidecarKind } from "../../../src/commands/runtime/shared.js";

interface FixtureRuntime {
	kind: string;
	port: number;
	grpcPort: number;
	startCmd: string;
	cwd: string;
	label: string;
}

interface FixtureOpts {
	runtimes?: FixtureRuntime[];
	workflowRef?: boolean;
	userNode?: boolean;
}

const goRuntime: FixtureRuntime = {
	kind: "go",
	port: 9001,
	grpcPort: 10001,
	startCmd: "go run ./cmd/server",
	cwd: ".blok/runtimes/go",
	label: "Go",
};

let tmpDirs: string[] = [];
let fakeSrc: string;

beforeEach(async () => {
	// A throwaway "blok repo" with an sdks/ dir so resolveSdkSource(--local) passes.
	fakeSrc = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-src-"));
	await fsp.mkdir(path.join(fakeSrc, "sdks"), { recursive: true });
	tmpDirs.push(fakeSrc);
});

afterEach(async () => {
	process.exitCode = 0;
	await Promise.all(tmpDirs.map((d) => fsp.rm(d, { recursive: true, force: true })));
	tmpDirs = [];
	vi.clearAllMocks();
});

async function makeProject(opts: FixtureOpts = {}): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-runtime-"));
	tmpDirs.push(dir);

	await fsp.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "fixture", dependencies: { "@blokjs/runner": "^0.6.19" } }, null, 2),
	);

	const config: Record<string, unknown> = {
		triggers: {
			http: {
				kind: "http",
				label: "HTTP Trigger",
				port: 4000,
				entryPoint: "src/triggers/http/index.ts",
				startCmd: "bun run x",
			},
		},
	};
	let env = "API_KEY=secret\n";
	let sup = "[supervisord]\nnodaemon=true\n\n[program:http_trigger]\ncommand=bun run x\ndirectory=/app\n";

	if (opts.runtimes?.length) {
		config.runtimes = Object.fromEntries(opts.runtimes.map((r) => [r.kind, r]));
		env += "\n# Runtimes (auto-configured by blokctl)\n";
		for (const r of opts.runtimes) {
			const k = r.kind === "csharp" ? "CSHARP" : r.kind.toUpperCase();
			env += `RUNTIME_${k}_HOST=localhost\nRUNTIME_${k}_PORT=${r.port}\nRUNTIME_${k}_GRPC_PORT=${r.grpcPort}\n`;
			sup += `\n[program:${r.kind}_runtime]\ncommand=${r.startCmd}\ndirectory=/app/${r.cwd}\n`;
			await fsp.mkdir(path.join(dir, ".blok", "runtimes", r.kind), { recursive: true });
			await fsp.writeFile(path.join(dir, ".blok", "runtimes", r.kind, "marker.txt"), "sdk");
		}
		env += "BLOK_TRANSPORT=grpc\n";
	}

	await fsp.mkdir(path.join(dir, ".blok"), { recursive: true });
	await fsp.writeFile(path.join(dir, ".blok", "config.json"), JSON.stringify(config, null, 2));
	await fsp.writeFile(path.join(dir, ".env.local"), env);
	await fsp.writeFile(path.join(dir, "supervisord.conf"), sup);

	if (opts.workflowRef) {
		await fsp.mkdir(path.join(dir, "src", "workflows"), { recursive: true });
		await fsp.writeFile(
			path.join(dir, "src", "workflows", "chain.ts"),
			'export default { steps: [{ id: "x", use: "n", type: "runtime.go" }] };\n',
		);
	}
	if (opts.userNode) {
		await fsp.mkdir(path.join(dir, "runtimes", "go", "nodes"), { recursive: true });
		await fsp.writeFile(path.join(dir, "runtimes", "go", "nodes", "my-node.go"), "package nodes\n");
	}
	return dir;
}

const readConfig = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, ".blok", "config.json"), "utf8"));
const readEnv = (dir: string) => fs.readFileSync(path.join(dir, ".env.local"), "utf8");
const readSup = (dir: string) => fs.readFileSync(path.join(dir, "supervisord.conf"), "utf8");

describe("assertSidecarKind", () => {
	it("rejects in-process kinds and unknown languages, allows sidecars", () => {
		expect(() => assertSidecarKind("node")).toThrow(/in-process/);
		expect(() => assertSidecarKind("typescript")).toThrow(/in-process/);
		expect(() => assertSidecarKind("cobol")).toThrow(/Unknown runtime/);
		expect(() => assertSidecarKind("go")).not.toThrow();
		expect(() => assertSidecarKind("python3")).not.toThrow();
	});
});

describe("runtime add", () => {
	it("adds a runtime, preserving triggers + user env vars", async () => {
		const dir = await makeProject();
		await runtimeAdd("go", { directory: dir, yes: true, skipToolchainCheck: true, local: fakeSrc });

		const config = readConfig(dir);
		expect(config.runtimes.go).toBeDefined();
		expect(config.runtimes.go.grpcPort).toBe(10001);
		expect(config.triggers.http).toBeDefined(); // preserved

		const env = readEnv(dir);
		expect(env).toContain("RUNTIME_GO_GRPC_PORT=10001");
		expect(env).toContain("API_KEY=secret"); // user var preserved
		expect(env.match(/BLOK_TRANSPORT=grpc/g)?.length).toBe(1); // no dupes

		expect(readSup(dir)).toContain("[program:go_runtime]");
		expect(fs.existsSync(path.join(dir, ".blok", "runtimes", "go"))).toBe(true);
	});

	it("merges a second runtime without clobbering the first", async () => {
		const dir = await makeProject({ runtimes: [goRuntime] });
		await runtimeAdd("python3", { directory: dir, yes: true, skipToolchainCheck: true, local: fakeSrc });

		const config = readConfig(dir);
		expect(Object.keys(config.runtimes).sort()).toEqual(["go", "python3"]);
		const env = readEnv(dir);
		expect(env).toContain("RUNTIME_GO_GRPC_PORT=10001");
		expect(env).toContain("RUNTIME_PYTHON3_GRPC_PORT=10007");
		expect(env.match(/# Runtimes \(auto-configured by blokctl\)/g)?.length).toBe(1);
	});

	it("honors --grpc-port", async () => {
		const dir = await makeProject();
		await runtimeAdd("rust", {
			directory: dir,
			yes: true,
			skipToolchainCheck: true,
			local: fakeSrc,
			grpcPort: "20002",
		});
		expect(readConfig(dir).runtimes.rust.grpcPort).toBe(20002);
		expect(readEnv(dir)).toContain("RUNTIME_RUST_GRPC_PORT=20002");
	});

	it("rejects a gRPC-port clash with an existing runtime", async () => {
		const dir = await makeProject({ runtimes: [goRuntime] }); // go on 10001
		await runtimeAdd("rust", {
			directory: dir,
			yes: true,
			skipToolchainCheck: true,
			local: fakeSrc,
			grpcPort: "10001",
		});
		expect(process.exitCode).toBe(1); // reported error, no mutation
		expect(readConfig(dir).runtimes.rust).toBeUndefined();
	});
});

describe("runtime remove", () => {
	it("removes a runtime, undoes config/env/supervisord, deletes the SDK, keeps user nodes by default", async () => {
		const dir = await makeProject({ runtimes: [goRuntime], workflowRef: true, userNode: true });
		await runtimeRemove("go", { directory: dir, yes: true });

		const config = readConfig(dir);
		expect(config.runtimes).toBeUndefined(); // last runtime → key dropped
		expect(config.triggers.http).toBeDefined();

		const env = readEnv(dir);
		expect(env).not.toContain("RUNTIME_GO");
		expect(env).not.toContain("BLOK_TRANSPORT");
		expect(env).toContain("API_KEY=secret");

		expect(readSup(dir)).not.toContain("[program:go_runtime]");
		expect(readSup(dir)).toContain("[program:http_trigger]");

		expect(fs.existsSync(path.join(dir, ".blok", "runtimes", "go"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "runtimes", "go", "nodes", "my-node.go"))).toBe(true); // kept
	});

	it("deletes user nodes with --purge-nodes", async () => {
		const dir = await makeProject({ runtimes: [goRuntime], userNode: true });
		await runtimeRemove("go", { directory: dir, yes: true, purgeNodes: true });
		expect(fs.existsSync(path.join(dir, "runtimes", "go", "nodes"))).toBe(false);
	});

	it("is a friendly no-op when the runtime isn't installed", async () => {
		const dir = await makeProject();
		await expect(runtimeRemove("rust", { directory: dir, yes: true })).resolves.toBeUndefined();
		expect(process.exitCode).toBe(0);
		expect(readConfig(dir).runtimes).toBeUndefined();
	});

	it("keeps sibling runtimes when removing one of several", async () => {
		const rust: FixtureRuntime = {
			...goRuntime,
			kind: "rust",
			grpcPort: 10002,
			port: 9002,
			cwd: ".blok/runtimes/rust",
			label: "Rust",
		};
		const dir = await makeProject({ runtimes: [goRuntime, rust] });
		await runtimeRemove("go", { directory: dir, yes: true });
		const config = readConfig(dir);
		expect(Object.keys(config.runtimes)).toEqual(["rust"]);
		expect(readEnv(dir)).toContain("RUNTIME_RUST_GRPC_PORT=10002");
		expect(readEnv(dir)).not.toContain("RUNTIME_GO");
	});
});

describe("runtime list --json", () => {
	it("reports installed + available runtimes", async () => {
		const dir = await makeProject({ runtimes: [goRuntime] });
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((m) => {
			lines.push(String(m));
		});
		await runtimeList({ directory: dir, json: true });
		spy.mockRestore();

		const out = JSON.parse(lines.join("\n"));
		expect(out.installed.map((r: { kind: string }) => r.kind)).toContain("go");
		expect(out.available.map((r: { kind: string }) => r.kind)).not.toContain("go");
		expect(out.available.length).toBeGreaterThan(0);
	});
});
