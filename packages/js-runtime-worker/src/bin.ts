#!/usr/bin/env node
/**
 * `blok-runtime-worker` — boot the persistent JavaScript runtime worker.
 *
 * Run it with whichever engine the project selected; the worker reports the
 * engine it is actually executing under, so a mismatch is visible rather than
 * silently reinterpreted:
 *
 *   node   node_modules/@blokjs/runtime-worker/dist/bin.js
 *   bun    node_modules/@blokjs/runtime-worker/dist/bin.js
 *   deno run --allow-net --allow-read --allow-env node_modules/@blokjs/runtime-worker/dist/bin.js
 *
 * Environment (all optional):
 *   GRPC_PORT / BLOK_WORKER_PORT   gRPC port (default: per-engine, see DEFAULT_WORKER_PORTS)
 *   HOST                           bind address (default 127.0.0.1)
 *   BLOK_WORKER_NODES              project node module (default: auto-detected from cwd)
 *   BLOK_WORKER_BUILTINS=0         serve only the project's nodes
 *   BLOK_GRPC_MAX_MESSAGE_BYTES    symmetric message ceiling (default 16 MiB)
 *   BLOK_WORKER_MAX_CONCURRENCY    in-flight executions (default 64)
 *   BLOK_WORKER_MAX_QUEUE          queued executions before overload (default 256)
 *   BLOK_BLOB_DIR                  shared claim-check directory (enables blob-v1)
 */

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCapabilityManifest } from "@blokjs/shared";
import { resolveBlobDir } from "./claimCheck.js";
import { buildRuntimeCapabilityManifest, detectHostRuntime, detectHostVersion } from "./host.js";
import { createWorkerRegistry, startWorker } from "./index.js";
import { declaredEffects, denoPermissionGrants, parseNetAllowList } from "./permissions.js";
import { WORKER_DEFAULTS } from "./server.js";

/** This package's own version, read from the package.json beside `dist/`. */
const WORKER_VERSION: string = (() => {
	try {
		const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

const HELP = `blok-runtime-worker ${WORKER_VERSION} — the persistent JavaScript execution worker for Blok.

Usage:
  <node|bun|deno run [flags]> node_modules/@blokjs/runtime-worker/dist/bin.js [options]

Options:
  --version, -v          Print the worker version and exit
  --help, -h             Print this help and exit
  --print-manifest       Print the runtime capability manifest (JSON) and exit
  --print-permissions    Print the effects the loaded nodes declare plus the
                         Deno --allow-* flags derived from them, and exit

Environment:
  GRPC_PORT / BLOK_WORKER_PORT   gRPC port (default: 10012 node, 10013 bun, 10014 deno)
  HOST                           Bind address (default 127.0.0.1)
  BLOK_WORKER_NODES              Project node module (default: auto-detected from cwd)
  BLOK_WORKER_BUILTINS=0         Serve only the project's nodes
  BLOK_WORKER_CONFORMANCE=1      Also serve the portable conformance fixture set (ADR 0016 §4)
  BLOK_GRPC_MAX_MESSAGE_BYTES    Symmetric message ceiling (default 16 MiB)
  BLOK_WORKER_MAX_CONCURRENCY    In-flight executions (default 64)
  BLOK_WORKER_MAX_QUEUE          Queued executions before overload (default 256)
  BLOK_BLOB_DIR                  Shared claim-check directory (enables blob-v1)
  BLOK_DENO_ALLOW_ALL=1          Launch Deno with --allow-all (diagnosed; not a production default)
  BLOK_DENO_ALLOW_NET            Comma-separated host[:port] allow-list scoping the network effect's
                                 --allow-net grant (default: unrestricted when a node declares network)

Docs: https://github.com/well-prado/blok/blob/main/docs/d/cli/runtimes.mdx`;

function intEnv(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

async function main(): Promise<void> {
	const runtime = detectHostRuntime();
	const maxMessageBytes = intEnv("BLOK_GRPC_MAX_MESSAGE_BYTES", WORKER_DEFAULTS.MAX_MESSAGE_BYTES);

	// `--version` / `--help` must PRINT AND EXIT. A bin that ignores an unknown
	// flag and boots a server instead hangs anything that probes it — which is
	// exactly what the packed-artifact gate does to every `bin` it installs.
	if (process.argv.includes("--version") || process.argv.includes("-v")) {
		console.log(WORKER_VERSION);
		return;
	}
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(HELP);
		return;
	}

	if (process.argv.includes("--print-manifest")) {
		console.log(JSON.stringify(buildRuntimeCapabilityManifest({ runtime, maxMessageBytes }), null, 2));
		return;
	}

	// Phase 1 of the Deno two-phase boot: load exactly the nodes this worker
	// would serve and report the effects they DECLARE, so the launcher can
	// derive least-privilege `--allow-*` flags instead of guessing. Printed on
	// a single marked line so a caller can pick it out of the load logs.
	if (process.argv.includes("--print-permissions")) {
		const registry = await createWorkerRegistry({
			nodesModule: process.env.BLOK_WORKER_NODES,
			builtins: process.env.BLOK_WORKER_BUILTINS !== "0",
		});
		const effects = declaredEffects(
			registry.descriptors().map((d) => {
				try {
					return parseCapabilityManifest(d.capabilityManifest);
				} catch {
					return undefined;
				}
			}),
		);
		const options = {
			port: intEnv("GRPC_PORT", intEnv("BLOK_WORKER_PORT", 0)),
			projectRoot: process.cwd(),
			blobDir: resolveBlobDir(),
			// `dist/bin.js` → the package root, resolved through any symlink.
			workerRoot: path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), ".."),
			allowAll: process.env.BLOK_DENO_ALLOW_ALL === "1",
			netAllow: parseNetAllowList(process.env.BLOK_DENO_ALLOW_NET),
		};
		if (options.allowAll) {
			console.warn(
				"[blok][worker] BLOK_DENO_ALLOW_ALL=1 — the Deno worker will run with --allow-all. This is NOT a production default; it disables the only native permission boundary Blok has.",
			);
		}
		const grants = denoPermissionGrants(effects, options);
		console.log(`BLOK_PERMISSIONS ${JSON.stringify({ effects, flags: grants.map((g) => g.flag), grants })}`);
		return;
	}

	const worker = await startWorker({
		port: intEnv("GRPC_PORT", intEnv("BLOK_WORKER_PORT", 0)) || undefined,
		host: process.env.HOST,
		nodesModule: process.env.BLOK_WORKER_NODES,
		builtins: process.env.BLOK_WORKER_BUILTINS !== "0",
		maxMessageBytes,
		maxConcurrency: intEnv("BLOK_WORKER_MAX_CONCURRENCY", WORKER_DEFAULTS.MAX_CONCURRENCY),
		maxQueue: intEnv("BLOK_WORKER_MAX_QUEUE", WORKER_DEFAULTS.MAX_QUEUE),
	});

	console.log(
		`[blok][worker] runtime.${runtime === "node" ? "nodejs" : runtime} serving on ${process.env.HOST ?? "127.0.0.1"}:${worker.port} (${runtime} ${detectHostVersion(runtime)}, ${worker.nodes.length} node(s))`,
	);

	let stopping = false;
	const stop = (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`[blok][worker] ${signal} — draining in-flight executions…`);
		worker.shutdown().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err: unknown) => {
	console.error(`[blok][worker] failed to start: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
