/**
 * Host detection and the runtime capability manifest (ADR 0016 §4).
 *
 * The worker binary is the SAME code under all three engines; only these
 * few facts differ. Keeping them in one table is what lets the rest of the
 * worker stay engine-agnostic.
 */

import {
	type JavaScriptRuntime,
	type RuntimeCapabilityManifest,
	RuntimeCapabilityManifestSchema,
	type RuntimeKind,
} from "@blokjs/shared";

/** Protocol version this worker speaks — the `blok.runtime.v1` contract. */
export const PROTOCOL_VERSION = "1.0.0";

/** Default gRPC ports, mirrored by `DEFAULT_GRPC_PORTS` in `@blokjs/runner`. */
export const DEFAULT_WORKER_PORTS: Readonly<Record<JavaScriptRuntime, number>> = {
	node: 10012,
	bun: 10013,
	deno: 10014,
};

/** Minimum engine versions the worker is tested against. */
export const MIN_ENGINE_VERSIONS: Readonly<Record<JavaScriptRuntime, string>> = {
	node: "20.0.0",
	bun: "1.1.0",
	// 2.7.5 is the first release whose Node-compat HTTP/2 server completes a
	// gRPC connection; earlier versions bind the port and then never answer.
	deno: "2.7.5",
};

interface BunGlobal {
	version?: string;
}
interface DenoGlobal {
	version?: { deno?: string };
}

/**
 * Which engine is executing this process. Order matters: Bun and Deno both
 * emulate enough of `process` that a `process.release` probe alone would
 * mis-report them as Node.js.
 */
export function detectHostRuntime(): JavaScriptRuntime {
	if ("Deno" in globalThis) return "deno";
	if ("Bun" in globalThis) return "bun";
	return "node";
}

/** Semantic version of the engine executing this process (best effort). */
export function detectHostVersion(runtime: JavaScriptRuntime = detectHostRuntime()): string {
	if (runtime === "deno") {
		const deno = (globalThis as unknown as { Deno?: DenoGlobal }).Deno;
		return deno?.version?.deno ?? "0.0.0";
	}
	if (runtime === "bun") {
		const bun = (globalThis as unknown as { Bun?: BunGlobal }).Bun;
		return bun?.version ?? "0.0.0";
	}
	return (process.versions?.node ?? "0.0.0").replace(/^v/, "");
}

/** Canonical runner/step kind for a project target. `node` → `nodejs`. */
export function runtimeKindOf(runtime: JavaScriptRuntime): RuntimeKind {
	return runtime === "node" ? "nodejs" : runtime;
}

/** SDK identity reported in every `NodeError` and `ListNodes` response. */
export function sdkNameOf(runtime: JavaScriptRuntime): string {
	return `blok-js-${runtime}`;
}

/**
 * Effective permission posture. Node.js and Bun have no native permission
 * boundary, so they report what the Blok-level policy grants; Deno reports
 * what its own `--allow-*` flags actually granted, probed at boot.
 *
 * ponytail: Deno's probe is a synchronous `permissions.querySync` on the four
 * coarse buckets. Fine-grained (per-path / per-host) reporting lands with the
 * capability-derived flag generation in slice 2.
 */
function permissionsFor(runtime: JavaScriptRuntime): RuntimeCapabilityManifest["permissions"] {
	if (runtime !== "deno") {
		return {
			filesystem: "read-write",
			network: "unrestricted",
			environment: "unrestricted",
			subprocess: "unrestricted",
			ffi: "unrestricted",
			secrets: "declared",
		};
	}
	const deno = (globalThis as unknown as { Deno?: { permissions?: DenoPermissions } }).Deno;
	const granted = (name: DenoPermissionName): boolean => {
		try {
			return deno?.permissions?.querySync?.({ name })?.state === "granted";
		} catch {
			return false;
		}
	};
	return {
		filesystem: granted("write") ? "read-write" : granted("read") ? "read" : "none",
		network: granted("net") ? "unrestricted" : "none",
		environment: granted("env") ? "unrestricted" : "declared",
		subprocess: granted("run") ? "unrestricted" : "none",
		ffi: granted("ffi") ? "unrestricted" : "none",
		secrets: "declared",
	};
}

type DenoPermissionName = "read" | "write" | "net" | "env" | "run" | "ffi";
interface DenoPermissions {
	querySync?(desc: { name: DenoPermissionName }): { state: string } | undefined;
}

/**
 * The runtime capability manifest this worker advertises (ADR 0016 §4). Shape
 * is validated by the shared Zod schema so a drifting worker fails at boot
 * instead of shipping a manifest nothing can parse.
 */
export function buildRuntimeCapabilityManifest(options: {
	runtime?: JavaScriptRuntime;
	maxMessageBytes: number;
}): RuntimeCapabilityManifest {
	const runtime = options.runtime ?? detectHostRuntime();
	return RuntimeCapabilityManifestSchema.parse({
		runtime,
		version: detectHostVersion(runtime),
		protocolVersion: PROTOCOL_VERSION,
		// All three engines load the worker and the project's nodes as ESM.
		moduleFormats: runtime === "deno" ? ["esm"] : ["esm", "commonjs"],
		// Node.js needs the project's build step (or a loader); Bun and Deno
		// execute TypeScript sources directly.
		typescriptExecution: runtime === "node" ? "loader" : "native",
		npmCompatibility: runtime === "deno" ? "compatibility" : "native",
		permissions: permissionsFor(runtime),
		cancellation: true,
		streaming: true,
		maxMessageBytes: options.maxMessageBytes,
	});
}
