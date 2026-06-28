/**
 * build-schema.ts — emits a JSON Schema draft-07 document for the v2
 * workflow envelope, sourced from `WorkflowV2Schema` (Zod). One generator,
 * one artifact (the consolidation — S1 §7.4). Consumed by:
 *
 * - The Blok VS Code extension (`packages/vscode-extension/schemas/workflow.v2.json`)
 *   — provides inline docs + autocomplete for `.json` workflow files. VS Code
 *   can't resolve a node `exports` path for `json.schemas`, so the extension
 *   gets a bundled copy written here at build time; the anti-drift test keeps
 *   it honest.
 * - `@blokjs/helper/schema` (the package export) — any tool that consumes
 *   JSON Schema can validate and autocomplete v2 workflows.
 *
 * Run as part of the helper package's `build` script. Outputs (identical bytes):
 *
 *   core/workflow-helper/schemas/workflow.v2.json   (checked in, ships via package)
 *   core/workflow-helper/dist/workflow.schema.json  (build artifact)
 *   packages/vscode-extension/schemas/workflow.v2.json (bundled into the extension)
 *
 * Schemas already carry `.describe(...)` on every v2 field, so the generated
 * output includes inline documentation strings for every property. No manual
 * annotation needed. `$refStrategy: "none"` is verified working for the
 * recursive `z.lazy` step kinds (forEach/loop/switch/tryCatch) — do NOT change it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WorkflowV2Schema } from "../src/types/WorkflowOpts";

/** Stable identifier for the published schema. Need not resolve. */
export const WORKFLOW_SCHEMA_ID = "https://schemas.blok.build/workflow/v2.json";

/**
 * Build the canonical v2 JSON Schema document. Shared with the anti-drift
 * test so the test and the generator can never diverge in HOW they generate.
 */
export function buildWorkflowSchema() {
	const out = zodToJsonSchema(WorkflowV2Schema, {
		name: "BlokWorkflowV2",
		target: "jsonSchema7",
		$refStrategy: "none",
	});

	// `zod-to-json-schema` wraps the schema under `definitions.BlokWorkflowV2`
	// when `name` is given. Lift it back to the root for editor consumption,
	// but keep the `$schema`/`$id` identifiers and a top-level
	// `title` + `description`.
	const wrapped = out as {
		$schema?: string;
		$ref?: string;
		definitions?: Record<string, unknown>;
	};
	const inner = wrapped.definitions?.BlokWorkflowV2 ?? wrapped;

	return {
		$schema: "http://json-schema.org/draft-07/schema#",
		$id: WORKFLOW_SCHEMA_ID,
		title: "Blok Workflow v2",
		description:
			"Schema for Blok v2 JSON workflows. Steps inline their `inputs`; output auto-persists to ctx.state[id]. " +
			"Use the `branch` step shape for if/else flow control. See https://blok.build/docs/workflow-v2 for full reference.",
		...(typeof inner === "object" && inner !== null ? inner : {}),
	};
}

// Emit only when run as a script (not when imported by the anti-drift test).
if (import.meta.main) {
	const finalSchema = buildWorkflowSchema();
	const serialized = `${JSON.stringify(finalSchema, null, "\t")}\n`;

	const targets = [
		resolve(import.meta.dirname, "..", "schemas", "workflow.v2.json"),
		resolve(import.meta.dirname, "..", "dist", "workflow.schema.json"),
		resolve(import.meta.dirname, "..", "..", "..", "packages", "vscode-extension", "schemas", "workflow.v2.json"),
	];

	for (const targetPath of targets) {
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, serialized, "utf8");
		console.log(`[build-schema] wrote ${targetPath}`);
	}
}
