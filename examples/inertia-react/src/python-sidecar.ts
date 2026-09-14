/**
 * Start the `runtime.python3` sidecar alongside this example's HTTP server, so
 * the Dashboard's `stats` prop resolves for real instead of showing its rescue
 * text.
 *
 * A scaffolded project gets this for free: `blokctl dev` reads
 * `.blok/config.json`, spawns every configured runtime and points it at
 * `runtimes/<lang>/nodes`. This example boots `src/index.ts` directly (see the
 * README), so it does the same three things by hand:
 *
 *   1. find an interpreter that has `grpcio` (the venv under
 *      `runtimes/python3/python3_runtime`, or `$BLOK_PYTHON` / `python3`);
 *   2. create that venv on first run — the SDK's `requirements.txt` is what
 *      `blokctl runtime add python3` installs;
 *   3. spawn `sdks/python3/bin/serve.py` in gRPC mode on the port the runner
 *      dials (`RUNTIME_PYTHON3_GRPC_PORT`, default 10007) with
 *      `BLOK_NODES_DIR` pointing at this example's `runtimes/python3/nodes`.
 *
 * Nothing here is required: with no python3 at all the page still renders,
 * because the prop is `defer(dashboardStats, { rescue: true })`.
 *
 * ponytail: POSIX layout only (`<venv>/bin/python3`) — this is a dev-loop
 * example, and the repo's other runtime launchers (`scripts/dev-full.ts`)
 * assume the same.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const sdkDir = resolve(exampleRoot, "..", "..", "sdks", "python3");
// `python3_runtime` is the venv name `blokctl runtime add python3` uses (and
// the one the repo's .gitignore already covers).
const venvDir = join(exampleRoot, "runtimes", "python3", "python3_runtime");
const venvPython = join(venvDir, "bin", "python3");
const nodesDir = join(exampleRoot, "runtimes", "python3", "nodes");

/** The gRPC port the runner dials for `runtime.python3` (`Configuration.ts`). */
export const pythonGrpcPort = (): number => Number(process.env.RUNTIME_PYTHON3_GRPC_PORT ?? 10007);

/** One-time setup, as a copy-pasteable line for the operator. */
export const SETUP_HINT = "run `bun run setup:python` (or see the README) once";

/**
 * Both halves of "this interpreter can serve our node".
 *
 * `import grpc` — since v0.5 the runner speaks only gRPC, so a python3 without
 * grpcio cannot boot the sidecar at all.
 *
 * 3.11 — the SDK's typed `@node` authoring imports `typing.NotRequired`, which
 * is 3.11+, and `bin/serve.py` swallows that ImportError: an older interpreter
 * boots a sidecar that serves the built-in nodes and ZERO user nodes, with no
 * diagnostic. Found on macOS's stock python3 (3.9); reported as
 * https://github.com/well-prado/blok/issues/1064.
 */
function usable(python: string): boolean {
	return (
		spawnSync(python, ["-c", "import sys, grpc; sys.exit(0 if sys.version_info >= (3, 11) else 1)"], {
			stdio: "ignore",
		}).status === 0
	);
}

/** The interpreter the sidecar can boot on, or `null` when none is ready. */
export function findPython(): string | null {
	if (existsSync(venvPython) && usable(venvPython)) return venvPython;
	const system = process.env.BLOK_PYTHON ?? "python3";
	return usable(system) ? system : null;
}

/** Create `runtimes/python3/python3_runtime` and install the SDK's requirements into it. */
export function installPython(): string | null {
	const system = process.env.BLOK_PYTHON ?? "python3";
	// Check the VERSION before building a venv around it: grpcio is what the
	// install adds, 3.11 is what it cannot fix (see `usable`).
	const version = spawnSync(system, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
		encoding: "utf8",
	});
	if (version.status !== 0) return null;
	const [major, minor] = version.stdout.trim().split(".").map(Number);
	if (major < 3 || (major === 3 && minor < 11)) {
		console.warn(
			`[example] ${system} is ${version.stdout.trim()}; the Blok Python SDK's typed nodes need 3.11+. Set BLOK_PYTHON=/path/to/python3.12 and try again.`,
		);
		return null;
	}

	console.log("[example] first run: creating runtimes/python3/python3_runtime for the runtime.python3 sidecar…");
	if (spawnSync(system, ["-m", "venv", venvDir], { stdio: "inherit" }).status !== 0) return null;
	spawnSync(join(venvDir, "bin", "pip"), ["install", "-q", "-r", join(sdkDir, "requirements.txt")], {
		stdio: "inherit",
	});
	return existsSync(venvPython) && usable(venvPython) ? venvPython : null;
}

/** Resolve when something is listening on `port`; reject after `timeoutMs`. */
export async function waitForSidecar(port: number, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const up = await new Promise<boolean>((done) => {
			const socket = connect({ port, host: "127.0.0.1" });
			socket.once("connect", () => {
				socket.destroy();
				done(true);
			});
			socket.once("error", () => {
				socket.destroy();
				done(false);
			});
		});
		if (up) return;
		await new Promise((sleep) => setTimeout(sleep, 200));
	}
	throw new Error(`the runtime.python3 sidecar never listened on 127.0.0.1:${port}`);
}

/**
 * Spawn the sidecar. Returns `null` — after saying why on stdout — when no
 * usable python3 is around; the caller carries on and the prop is rescued.
 */
export function startPythonSidecar(opts: { port?: number; install?: boolean } = {}): ChildProcess | null {
	const port = opts.port ?? pythonGrpcPort();
	const python = findPython() ?? (opts.install === false ? null : installPython());
	if (python === null) {
		console.warn(
			`[example] no python3 with grpcio found — runtime.python3 is not running, so the Dashboard's "Revenue (Python)" tile shows its rescue text. To fix: ${SETUP_HINT}.`,
		);
		return null;
	}

	const child = spawn(python, [join(sdkDir, "bin", "serve.py")], {
		cwd: sdkDir,
		env: {
			...process.env,
			HOST: "127.0.0.1",
			GRPC_PORT: String(port),
			// Pinned so the sidecar does not inherit the HTTP server's own `PORT`.
			// Unused while the transport is gRPC, but a shared value here is the
			// kind of thing that bites the day someone flips BLOK_TRANSPORT.
			PORT: "9007",
			BLOK_TRANSPORT: "grpc",
			// The sidecar fs-scans this at boot: `<dir>/<name>/node.py`.
			BLOK_NODES_DIR: nodesDir,
			PYTHONUNBUFFERED: "1",
		},
		stdio: "inherit",
	});

	const stop = () => child.kill();
	process.once("exit", stop);
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	return child;
}
