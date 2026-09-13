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

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCapabilityManifest } from "@blokjs/shared";
import { resolveBlobDir } from "./claimCheck.js";
import { buildRuntimeCapabilityManifest, detectHostRuntime, detectHostVersion } from "./host.js";
import { createWorkerRegistry, startWorker } from "./index.js";
import { declaredEffects, denoPermissionFlags } from "./permissions.js";
import { WORKER_DEFAULTS } from "./server.js";

function intEnv(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

async function main(): Promise<void> {
	const runtime = detectHostRuntime();
	const maxMessageBytes = intEnv("BLOK_GRPC_MAX_MESSAGE_BYTES", WORKER_DEFAULTS.MAX_MESSAGE_BYTES);

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
		};
		if (options.allowAll) {
			console.warn(
				"[blok][worker] BLOK_DENO_ALLOW_ALL=1 — the Deno worker will run with --allow-all. This is NOT a production default; it disables the only native permission boundary Blok has.",
			);
		}
		console.log(`BLOK_PERMISSIONS ${JSON.stringify({ effects, flags: denoPermissionFlags(effects, options) })}`);
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
