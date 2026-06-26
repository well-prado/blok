/**
 * Create-time helper: resolve a selected set of observability module ids (with
 * dependencies) into the `.blok/config.json` map + the `.env.local` blocks. Pure
 * — the caller does the file I/O. Shared shape with `observability add` so the
 * create-time picker and the retrofit command stay consistent.
 */

import type { ObservabilityModuleConfig } from "../../services/runtime-setup.js";
import { getObservabilityModule, resolveWithDependencies } from "./descriptor.js";

export function resolveObservabilitySelection(
	moduleIds: string[],
	opts: { addedAt: string; version?: string; projectDir: string },
): { configMap: Record<string, ObservabilityModuleConfig>; envBlocks: string[]; added: string[] } {
	if (moduleIds.length === 0) return { configMap: {}, envBlocks: [], added: [] };
	const { resolved, added } = resolveWithDependencies(moduleIds);
	const configMap: Record<string, ObservabilityModuleConfig> = {};
	for (const id of resolved) configMap[id] = { enabled: true, addedAt: opts.addedAt, version: opts.version };
	const envBlocks = resolved.map((id) => getObservabilityModule(id)?.envBlock({ projectDir: opts.projectDir }) ?? "");
	return { configMap, envBlocks, added };
}
