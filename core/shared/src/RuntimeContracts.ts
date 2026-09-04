import { z } from "zod";

/** The JavaScript execution targets that a project may select. */
export const JAVASCRIPT_RUNTIMES = ["node", "bun", "deno"] as const;
export const JavaScriptRuntimeSchema = z.enum(JAVASCRIPT_RUNTIMES);
export type JavaScriptRuntime = z.infer<typeof JavaScriptRuntimeSchema>;

/** Package managers are independent from the JavaScript execution target. */
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

/** Canonical runtime kinds used by the runner registry and step `type`. */
export const RUNTIME_KINDS = [
	"nodejs",
	"bun",
	"deno",
	"python3",
	"go",
	"java",
	"rust",
	"php",
	"csharp",
	"ruby",
	"docker",
	"wasm",
	"wasi",
] as const;
export const RuntimeKindSchema = z.enum(RUNTIME_KINDS);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

/** Inputs accepted at compatibility boundaries before canonicalization. */
export const RuntimeKindInputSchema = z.enum([...RUNTIME_KINDS, "node", "typescript", "ts"]);
export type RuntimeKindInput = z.infer<typeof RuntimeKindInputSchema>;

export type RuntimeDiagnostic = {
	code: "deprecated-runtime-alias";
	severity: "warning";
	input: string;
	canonical: string;
	message: string;
};

export type RuntimeNormalization = {
	kind: RuntimeKind;
	diagnostic?: RuntimeDiagnostic;
};

const RUNTIME_KIND_ALIASES: Record<string, RuntimeKind> = {
	node: "nodejs",
	typescript: "nodejs",
	ts: "nodejs",
};

/**
 * Normalize a runtime kind at a load/registry boundary.
 *
 * `runtime.nodejs` is the canonical step spelling. `node`, `typescript`, and
 * `ts` remain accepted for old workflows and CLI/config bridges, but callers
 * receive a diagnostic so compatibility never looks like an engine switch.
 */
export function normalizeRuntimeKind(input: string): RuntimeNormalization {
	const alias = RUNTIME_KIND_ALIASES[input.toLowerCase()];
	if (alias) {
		return {
			kind: alias,
			diagnostic: {
				code: "deprecated-runtime-alias",
				severity: "warning",
				input,
				canonical: alias,
				message: `Runtime alias "${input}" is deprecated; use "${alias}" for step execution. The selected JavaScript engine is not changed by this compatibility mapping.`,
			},
		};
	}

	return { kind: RuntimeKindSchema.parse(input) };
}

/** Normalize the project-level JavaScript selection vocabulary. */
export function normalizeJavaScriptRuntime(input: string): {
	runtime: JavaScriptRuntime;
	diagnostic?: RuntimeDiagnostic;
} {
	const normalized = input.toLowerCase();
	if (normalized === "nodejs" || normalized === "typescript" || normalized === "ts") {
		return {
			runtime: "node",
			diagnostic: {
				code: "deprecated-runtime-alias",
				severity: "warning",
				input,
				canonical: "node",
				message: `Project runtime alias "${input}" is deprecated; use "node" in .blok/config.json.`,
			},
		};
	}
	return { runtime: JavaScriptRuntimeSchema.parse(normalized) };
}

/** Convert a project selection to the public step/registry kind. */
export function runtimeKindForJavaScriptRuntime(runtime: JavaScriptRuntime): RuntimeKind {
	return runtime === "node" ? "nodejs" : runtime;
}

/** The runtime-specific capability declaration shared by workers and tooling. */
export const RuntimeCapabilityManifestSchema = z
	.object({
		runtime: JavaScriptRuntimeSchema,
		version: z.string().min(1),
		protocolVersion: z.string().min(1),
		moduleFormats: z.array(z.enum(["esm", "commonjs"])).min(1),
		typescriptExecution: z.enum(["native", "transpile", "loader"]),
		npmCompatibility: z.enum(["native", "compatibility", "none"]),
		permissions: z.object({
			filesystem: z.enum(["none", "read", "read-write"]),
			network: z.enum(["none", "restricted", "unrestricted"]),
			environment: z.enum(["none", "declared", "unrestricted"]),
			subprocess: z.enum(["none", "declared", "unrestricted"]),
			ffi: z.enum(["none", "declared", "unrestricted"]),
			secrets: z.enum(["none", "declared"]),
		}),
		cancellation: z.boolean(),
		streaming: z.boolean(),
		maxMessageBytes: z.number().int().positive(),
	})
	.strict();
export type RuntimeCapabilityManifest = z.infer<typeof RuntimeCapabilityManifestSchema>;

/** Project configuration fields for JS runtime selection and package policy. */
export const JavaScriptRuntimeSelectionSchema = z
	.object({
		runtime: JavaScriptRuntimeSchema.default("node"),
		packageManager: PackageManagerSchema.optional(),
	})
	.strict();
export type JavaScriptRuntimeSelection = z.infer<typeof JavaScriptRuntimeSelectionSchema>;
