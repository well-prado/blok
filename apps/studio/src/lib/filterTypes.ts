import type { ReactNode } from "react";

export type TimePeriod = { type: "relative"; value: string } | { type: "absolute"; from: number; to: number };

export interface FilterState {
	status: string[];
	workflow: string[];
	triggerType: string[];
	runtimeKind: string[];
	node: string[];
	tags: string[];
	metadata: Record<string, string>;
	timePeriod: TimePeriod | null;
	durationBucket: string | null;
}

export const EMPTY_FILTER: FilterState = {
	status: [],
	workflow: [],
	triggerType: [],
	runtimeKind: [],
	node: [],
	tags: [],
	metadata: {},
	timePeriod: null,
	durationBucket: null,
};

export interface FilterFieldDef {
	key: keyof FilterState;
	label: string;
	icon?: ReactNode;
}

// List of available filter fields for the FilterMenu (TimePeriod handles its own UI)
export const FILTER_FIELDS: FilterFieldDef[] = [
	{ key: "status", label: "Status" },
	{ key: "workflow", label: "Workflow" },
	{ key: "triggerType", label: "Trigger Type" },
	{ key: "runtimeKind", label: "Runtime" },
	{ key: "node", label: "Node" },
	{ key: "tags", label: "Tags" },
	{ key: "durationBucket", label: "Duration" },
	{ key: "metadata", label: "Metadata" },
];

export function isFilterEmpty(state: FilterState): boolean {
	if (state.status.length > 0) return false;
	if (state.workflow.length > 0) return false;
	if (state.triggerType.length > 0) return false;
	if (state.runtimeKind.length > 0) return false;
	if (state.node.length > 0) return false;
	if (state.tags.length > 0) return false;
	if (Object.keys(state.metadata).length > 0) return false;
	if (state.timePeriod !== null) return false;
	if (state.durationBucket !== null) return false;
	return true;
}

export function countActiveFilters(state: FilterState): number {
	let count = 0;
	count += state.status.length;
	count += state.workflow.length;
	count += state.triggerType.length;
	count += state.runtimeKind.length;
	count += state.node.length;
	count += state.tags.length;
	count += Object.keys(state.metadata).length;
	if (state.timePeriod !== null) count += 1;
	if (state.durationBucket !== null) count += 1;
	return count;
}
