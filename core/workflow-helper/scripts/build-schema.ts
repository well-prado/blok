/**
 * build-schema.ts — emits a JSON Schema draft-07 document for the v2
 * workflow envelope, sourced from `WorkflowV2Schema` (Zod). Used by:
 *
 * - The Blok VS Code extension (`packages/vscode-extension/schemas/workflow.schema.json`)
 *   — provides inline docs + autocomplete for `.json` workflow files.
 * - Editor `json.schemas` settings — any tool that consumes JSON Schema
 *   can validate and autocomplete v2 workflows.
 *
 * Run as part of the helper package's `build` script. Output:
 *
 *   core/workflow-helper/dist/workflow.schema.json
 *
 * Schemas already carry `.describe(...)` on every v2 field, so the
 * generated output includes inline documentation strings for every
 * property. No manual annotation needed.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WorkflowV2Schema } from "../src/types/WorkflowOpts";

const out = zodToJsonSchema(WorkflowV2Schema, {
	name: "BlokWorkflowV2",
	target: "jsonSchema7",
	$refStrategy: "none",
});

// `zod-to-json-schema` wraps the schema under `definitions.BlokWorkflowV2`
// when `name` is given. Lift it back to the root for editor consumption,
// but keep the `$schema` identifier and a top-level `title` + `description`.
const wrapped = out as {
	$schema?: string;
	$ref?: string;
	definitions?: Record<string, unknown>;
};
const inner = wrapped.definitions?.BlokWorkflowV2 ?? wrapped;

const finalSchema = {
	$schema: "http://json-schema.org/draft-07/schema#",
	title: "Blok Workflow v2",
	description:
		"Schema for Blok v2 JSON workflows. Steps inline their `inputs`; output auto-persists to ctx.state[id]. " +
		"Use the `branch` step shape for if/else flow control. See https://blok.build/docs/workflow-v2 for full reference.",
	...(typeof inner === "object" && inner !== null ? inner : {}),
};

const targetPath = resolve(import.meta.dirname, "..", "dist", "workflow.schema.json");
writeFileSync(targetPath, `${JSON.stringify(finalSchema, null, "\t")}\n`, "utf8");
console.log(`[build-schema] wrote ${targetPath}`);
