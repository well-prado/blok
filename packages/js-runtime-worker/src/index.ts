/**
 * `@blokjs/runtime-worker` — the persistent JavaScript/TypeScript execution
 * worker for Blok.
 *
 * One process per selected execution target (`node`, `bun`, or `deno`), serving
 * `blok.runtime.v1` over gRPC. The runner dials it with the same
 * `GrpcRuntimeAdapter` it uses for the eleven language SDKs, so a
 * `runtime.bun` / `runtime.deno` / cross-host `runtime.nodejs` step is an
 * ordinary remote step: no process per invocation, no silent fallback to
 * another engine.
 *
 * @example
 * ```ts
 * import { startWorker } from "@blokjs/runtime-worker";
 * const worker = await startWorker({ port: 10013, nodesModule: "./src/Nodes.ts" });
 * // ...
 * await worker.shutdown();
 * ```
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JavaScriptRuntime } from "@blokjs/shared";
import { builtinNodes } from "./builtins.js";
import { DEFAULT_WORKER_PORTS, detectHostRuntime } from "./host.js";
import { WorkerRegistry, loadNodesFromModule } from "./registry.js";
import { WORKER_DEFAULTS, type WorkerHandle, startWorkerServer } from "./server.js";

export {
	buildRuntimeCapabilityManifest,
	detectHostRuntime,
	detectHostVersion,
	DEFAULT_WORKER_PORTS,
	MIN_ENGINE_VERSIONS,
	PROTOCOL_VERSION,
	runtimeKindOf,
	sdkNameOf,
} from "./host.js";
export { WorkerRegistry, loadNodesFromModule } from "./registry.js";
export type { NodeDescriptor, WorkerNode } from "./registry.js";
export { RUNTIME_MANIFEST_METADATA_KEY, WORKER_DEFAULTS, startWorkerServer } from "./server.js";
export type { WorkerHandle, WorkerServerOptions } from "./server.js";
export { BLOB_CAPABILITY, resolveBlobDir } from "./claimCheck.js";
export { declaredEffects, denoIntrospectionFlags, denoPermissionFlags } from "./permissions.js";
export type { DenoPermissionOptions } from "./permissions.js";
export { WorkerError, toNodeError } from "./errors.js";

export interface StartWorkerOptions {
	/** gRPC port. Defaults to this engine's entry in {@link DEFAULT_WORKER_PORTS}. */
	port?: number;
	host?: string;
	/** Module whose default export is the project's node record (`src/Nodes.ts`).
	 * Auto-detected from `cwd` when omitted. */
	nodesModule?: string;
	/** Project root used for `nodesModule` auto-detection. Defaults to `cwd`. */
	projectRoot?: string;
	/** Register the cross-runtime conformance fixtures. Default true. */
	builtins?: boolean;
	maxMessageBytes?: number;
	maxConcurrency?: number;
	maxQueue?: number;
}

/** Candidate node-module paths, in the order this engine can load them. */
function nodeModuleCandidates(runtime: JavaScriptRuntime): string[] {
	// Node.js cannot import a `.ts` source without a loader, so a Node worker
	// reads the project's build output. Bun and Deno execute TypeScript
	// natively and prefer the source, which is what `blokctl dev` has on disk.
	return runtime === "node"
		? ["dist/Nodes.js", "dist/src/Nodes.js", "src/Nodes.js"]
		: ["src/Nodes.ts", "dist/Nodes.js", "dist/src/Nodes.js"];
}

function resolveNodesModule(options: StartWorkerOptions, runtime: JavaScriptRuntime): string | null {
	const root = options.projectRoot ?? process.cwd();
	if (options.nodesModule) {
		const explicit = path.isAbsolute(options.nodesModule)
			? options.nodesModule
			: path.resolve(root, options.nodesModule);
		return existsSync(explicit) ? pathToFileURL(explicit).href : options.nodesModule;
	}
	for (const candidate of nodeModuleCandidates(runtime)) {
		const abs = path.resolve(root, candidate);
		if (existsSync(abs)) return pathToFileURL(abs).href;
	}
	return null;
}

/**
 * Build the registry this worker will serve: the conformance built-ins plus
 * every node reachable from the project's node module. Separated from
 * {@link startWorker} so the permission-introspection pass can load exactly
 * the same nodes without binding a port.
 */
export async function createWorkerRegistry(options: StartWorkerOptions = {}): Promise<WorkerRegistry> {
	const runtime = detectHostRuntime();
	const registry = new WorkerRegistry();

	if (options.builtins !== false) {
		for (const node of builtinNodes(() => registry.executions)) registry.register(node);
	}

	const specifier = resolveNodesModule(options, runtime);
	if (specifier === null) {
		const hint =
			runtime === "node"
				? "Node.js cannot import TypeScript sources, so this worker reads the project's BUILD OUTPUT: run the project's build (`npm run build` / `bun run build`) before starting it, or point BLOK_WORKER_NODES at the module yourself."
				: "Point BLOK_WORKER_NODES at the project's node module if it lives somewhere else.";
		console.warn(
			`[blok][worker] no project node module found under ${options.projectRoot ?? process.cwd()} (looked for ${nodeModuleCandidates(runtime).join(", ")}). Serving built-in nodes only — runtime.${runtime === "node" ? "nodejs" : runtime} steps referencing a project node will fail with NODE_NOT_FOUND. ${hint}`,
		);
		return registry;
	}
	const loaded = await loadNodesFromModule(specifier);
	for (const node of loaded) {
		if (registry.has(node.name)) {
			console.warn(`[blok][worker] project node "${node.name}" shadows a built-in conformance node.`);
		}
		registry.register(node);
	}
	console.log(`[blok][worker] loaded ${loaded.length} project node(s) from ${specifier}`);
	return registry;
}

/**
 * Load the project's nodes, register the conformance built-ins, and start
 * serving. Resolves once the port is bound and the registry is populated —
 * i.e. once `Health` can honestly answer `SERVING`.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle & { nodes: string[] }> {
	const runtime = detectHostRuntime();
	const registry = await createWorkerRegistry(options);

	const handle = await startWorkerServer({
		registry,
		host: options.host,
		port: options.port ?? DEFAULT_WORKER_PORTS[runtime],
		runtime,
		maxMessageBytes: options.maxMessageBytes ?? WORKER_DEFAULTS.MAX_MESSAGE_BYTES,
		maxConcurrency: options.maxConcurrency,
		maxQueue: options.maxQueue,
	});

	return Object.assign(handle, { nodes: registry.names() });
}
