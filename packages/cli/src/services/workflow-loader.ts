/**
 * Workflow Loader - Scans and parses workflow files from a project directory.
 * Used by graph, profile, and cost CLI commands.
 */

import fs from "node:fs";
import path from "node:path";

export interface WorkflowDef {
	name: string;
	version: string;
	description?: string;
	trigger: Record<string, unknown>;
	steps: Array<{
		name: string;
		node: string;
		type?: string;
		runtime?: string;
		conditions?: Array<{
			type: "if" | "else";
			expression?: string;
			steps?: Array<{ name: string; node: string; type?: string; runtime?: string }>;
		}>;
	}>;
	nodes: Record<string, unknown>;
}

export interface LoadedWorkflow {
	name: string;
	filePath: string;
	def: WorkflowDef;
}

export async function loadWorkflows(directory: string): Promise<LoadedWorkflow[]> {
	const jsonDir = path.join(directory, "workflows", "json");

	if (!fs.existsSync(jsonDir)) {
		// Try looking in workflows/ directly
		const altDir = path.join(directory, "workflows");
		if (fs.existsSync(altDir)) {
			return scanDirectory(altDir);
		}
		return [];
	}

	return scanDirectory(jsonDir);
}

export async function loadWorkflow(directory: string, name: string): Promise<LoadedWorkflow | null> {
	const all = await loadWorkflows(directory);
	return all.find((w) => w.name === name) ?? null;
}

function scanDirectory(dir: string): LoadedWorkflow[] {
	const workflows: LoadedWorkflow[] = [];

	if (!fs.existsSync(dir)) return workflows;

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".json")) {
			const filePath = path.join(dir, entry.name);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const parsed = JSON.parse(content);

				// Validate it looks like a workflow
				if (parsed.name && parsed.trigger && parsed.steps && parsed.nodes) {
					workflows.push({
						name: parsed.name,
						filePath,
						def: parsed as WorkflowDef,
					});
				}
			} catch {
				// Skip invalid JSON files
			}
		} else if (entry.isDirectory()) {
			// Recurse into subdirectories
			const subWorkflows = scanDirectory(path.join(dir, entry.name));
			workflows.push(...subWorkflows);
		}
	}

	return workflows;
}
