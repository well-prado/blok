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
 *   1. find an interpreter that can serve our node — 3.11+ with `grpcio` and
 *      `pydantic` (the venv under `runtimes/python3/python3_runtime`, or
 *      `$BLOK_PYTHON` / `python3`);
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
import { registerShutdownCleanup } from "@blokjs/runner";

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
 * `import pydantic` — the typed `@node` decorator is built on it, so without it
 * `load_user_nodes` is a no-op and the sidecar starts with the SDK's built-ins
 * and none of ours. Both are in the SDK's `requirements.txt`; checking only
 * grpcio would let a half-installed environment boot a useless sidecar (and
 * fail `tests/python-stats.test.ts` instead of skipping it).
 *
 * 3.11 — the SDK's typed `@node` authoring imports `typing.NotRequired`, which
 * is 3.11+, and `bin/serve.py` swallows that ImportError: an older interpreter
 * boots a sidecar that serves the built-in nodes and ZERO user nodes, with no
 * diagnostic. Found on macOS's stock python3 (3.9); reported as
 * https://github.com/well-prado/blok/issues/1064.
 */
function usable(python: string): boolean {
	return (
		spawnSync(python, ["-c", "import sys, grpc, pydantic; sys.exit(0 if sys.version_info >= (3, 11) else 1)"], {
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

/**
 * Create `runtimes/python3/python3_runtime` and install the SDK's requirements
 * into it — unless a usable interpreter is already there, in which case this is
 * a no-op so `bun run setup:python` is cheap to re-run.
 */
export function installPython(): string | null {
	const ready = findPython();
	if (ready !== null) {
		console.log(`[example] runtime.python3 already has a usable interpreter: ${ready}`);
		return ready;
	}

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
			`[example] no python3 that can serve this example's node (3.11+ with grpcio and pydantic) — runtime.python3 is not running, so the Dashboard's "Revenue (Python)" tile shows its rescue text. To fix: ${SETUP_HINT}.`,
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

	// A spawn that never started, or a sidecar that dies later (its port taken,
	// the interpreter removed), must be LOUD: without these the first failure
	// throws out of the event loop and takes the server with it, and the second
	// one silently turns the Revenue tile back into its rescue text.
	child.on("error", (error) => {
		console.warn(`[example] the runtime.python3 sidecar failed to start: ${error.message}`);
	});
	child.on("exit", (code, signal) => {
		if (signal === "SIGTERM" || signal === "SIGKILL" || code === 0) return;
		console.warn(
			`[example] the runtime.python3 sidecar exited (code ${code}, signal ${signal}); the Dashboard's "Revenue (Python)" tile falls back to its rescue text. Port ${port} in use? Move it with RUNTIME_PYTHON3_GRPC_PORT (the runner and the sidecar read the same variable).`,
		);
	});

	// Shutdown goes through the framework's hook, NOT `process.once("SIGINT")`:
	// a signal listener of our own suppresses Node's default terminate, so with
	// `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1` (which turns off `TriggerBase`'s own
	// handlers) a `kill -TERM` would leave the server running forever.
	// `registerShutdownCleanup` runs inside that drain instead, and `exit` is
	// the belt-and-braces path for an exit nobody drained.
	const stop = (): void => {
		child.kill();
	};
	registerShutdownCleanup(stop);
	process.once("exit", stop);

	// …with one exception. `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1` means TriggerBase
	// installs no handlers and no drain runs, so a `kill -TERM` would terminate
	// the server by default action — which runs no `exit` handler either — and
	// leave the sidecar holding its port. Here a listener of our own is correct,
	// because it exits immediately with the signal's conventional status instead
	// of swallowing the terminate.
	if (process.env.BLOK_GRACEFUL_SHUTDOWN_DISABLED === "1") {
		for (const [signal, status] of [
			["SIGINT", 130],
			["SIGTERM", 143],
		] as const) {
			process.once(signal, () => {
				stop();
				process.exit(status);
			});
		}
	}

	return child;
}
