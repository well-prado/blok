import { extname, isAbsolute } from "node:path";
import { z } from "zod";

export const WORKFLOW_STUDIO_SCHEMA_URL = "https://blok.build/schemas/workflow-studio.v1.json";
const MAX_COORDINATE = 1_000_000;

const coordinate = z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE);

const nodeLayoutSchema = z
	.object({
		x: coordinate,
		y: coordinate,
		collapsed: z.boolean().optional(),
		notes: z.string().max(10_000).optional(),
	})
	.passthrough();

export const WorkflowStudioConfigV1Schema = z
	.object({
		$schema: z.string().url().default(WORKFLOW_STUDIO_SCHEMA_URL),
		schemaVersion: z.literal(1),
		workflow: z.string().min(1),
		canvas: z
			.object({
				direction: z.enum(["TB", "LR", "BT", "RL"]).default("TB"),
				defaultViewport: z
					.object({
						x: coordinate,
						y: coordinate,
						zoom: z.number().finite().min(0.05).max(8),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.default({ direction: "TB" }),
		nodes: z.record(nodeLayoutSchema).default({}),
		groups: z.record(z.unknown()).default({}),
		annotations: z.array(z.unknown()).default([]),
	})
	.passthrough();

export type WorkflowStudioConfigV1 = z.infer<typeof WorkflowStudioConfigV1Schema>;

export function parseWorkflowStudioConfig(input: unknown, expectedWorkflow?: string): WorkflowStudioConfigV1 {
	const config = WorkflowStudioConfigV1Schema.parse(input);
	if (expectedWorkflow !== undefined && config.workflow !== expectedWorkflow) {
		throw new Error(
			`Workflow Studio config belongs to "${config.workflow}", not registered workflow "${expectedWorkflow}".`,
		);
	}
	return config;
}

export function workflowStudioPath(sourcePath: string): string {
	if (!isAbsolute(sourcePath)) {
		throw new Error(`Workflow source must be an absolute filesystem path: ${sourcePath}`);
	}
	const extension = extname(sourcePath).toLowerCase();
	if (extension !== ".ts" && extension !== ".js" && extension !== ".json") {
		throw new Error(`Unsupported workflow source extension "${extension || "(none)"}".`);
	}
	return `${sourcePath.slice(0, -extension.length)}.studio.json`;
}

export function cleanWorkflowStudioOrphans(
	config: WorkflowStudioConfigV1,
	stepIds: ReadonlySet<string>,
): WorkflowStudioConfigV1 {
	return {
		...config,
		nodes: Object.fromEntries(Object.entries(config.nodes).filter(([stepId]) => stepIds.has(stepId))),
	};
}
