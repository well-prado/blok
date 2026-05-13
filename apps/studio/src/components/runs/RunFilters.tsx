import { useDeleteSavedFilter, useSavedFilters, useUpsertSavedFilter } from "@/hooks/useSavedFilters";
import { cn } from "@/lib/utils";
import type { SavedFilter } from "@/types";
import { useState } from "react";

interface RunFiltersProps {
	status: string;
	onStatusChange: (status: string) => void;
	tagsInput?: string;
	onTagsChange?: (tags: string) => void;
	metadataInput?: string;
	onMetadataChange?: (metadata: string) => void;
	className?: string;
}

/**
 * Status filter options — kept in sync with `WorkflowRunStatus`.
 * The dropdown grew during Tier 2 (throttled / delayed / expired /
 * debounced / crashed / timedOut). Order: most-common first, then
 * tier-grouped.
 */
const STATUS_OPTIONS: { value: string; label: string }[] = [
	{ value: "", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "completed", label: "Completed" },
	{ value: "failed", label: "Failed" },
	{ value: "cancelled", label: "Cancelled" },
	{ value: "throttled", label: "Throttled" },
	{ value: "delayed", label: "Delayed" },
	{ value: "expired", label: "Expired" },
	{ value: "debounced", label: "Debounced" },
	{ value: "crashed", label: "Crashed" },
	{ value: "timedOut", label: "Timed Out" },
];

export function RunFilters({
	status,
	onStatusChange,
	tagsInput,
	onTagsChange,
	metadataInput,
	onMetadataChange,
	className,
}: RunFiltersProps) {
	// Internal-state fallback so the component is usable without the
	// tag/metadata callbacks (preserves backward compat with callers that
	// only consume status).
	const [internalTags, setInternalTags] = useState("");
	const [internalMetadata, setInternalMetadata] = useState("");
	const tagsValue = tagsInput ?? internalTags;
	const metadataValue = metadataInput ?? internalMetadata;
	const setTags = onTagsChange ?? setInternalTags;
	const setMetadata = onMetadataChange ?? setInternalMetadata;

	// E2 · Saved filters now live server-side. The hook polls every
	// 15s so cross-browser / cross-tab Saves surface automatically.
	const savedFilters: SavedFilter[] = useSavedFilters();
	const upsertSavedFilter = useUpsertSavedFilter();
	const deleteSavedFilterMutation = useDeleteSavedFilter();
	const [savedSelected, setSavedSelected] = useState<string>("");

	const handleApplySaved = (name: string) => {
		setSavedSelected(name);
		if (!name) return;
		const filter = savedFilters.find((f) => f.name === name);
		if (!filter) return;
		onStatusChange(filter.status);
		setTags(filter.tagsInput);
		setMetadata(filter.metadataInput);
	};

	const handleSaveCurrent = () => {
		const name = (typeof window !== "undefined" ? window.prompt("Name this filter:", "My filter") : null)?.trim();
		if (!name) return;
		upsertSavedFilter.mutate(
			{ name, status, tagsInput: tagsValue, metadataInput: metadataValue },
			{
				onSuccess: () => setSavedSelected(name),
			},
		);
	};

	const handleDeleteSelected = () => {
		if (!savedSelected) return;
		if (typeof window !== "undefined" && !window.confirm(`Delete saved filter "${savedSelected}"?`)) return;
		deleteSavedFilterMutation.mutate(savedSelected, {
			onSuccess: () => setSavedSelected(""),
		});
	};

	return (
		<div className={cn("flex flex-wrap items-center gap-3", className)}>
			<div className="flex items-center gap-2">
				<span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mr-1">Status</span>
				<select
					value={status}
					onChange={(e) => onStatusChange(e.target.value)}
					className={cn(
						"px-2 py-1 text-xs font-medium rounded-md border border-zinc-800 bg-canvas",
						"text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blok-green-500",
					)}
				>
					{STATUS_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
			</div>

			<div className="flex items-center gap-2">
				<span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mr-1">Tags</span>
				<input
					type="text"
					value={tagsValue}
					onChange={(e) => setTags(e.target.value)}
					placeholder="user-123, premium"
					className={cn(
						"px-2 py-1 text-xs font-medium rounded-md border border-zinc-800 bg-canvas",
						"text-zinc-100 placeholder:text-zinc-600 w-40",
						"focus:outline-none focus:ring-1 focus:ring-blok-green-500",
					)}
				/>
			</div>

			<div className="flex items-center gap-2">
				<span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mr-1">Metadata</span>
				<input
					type="text"
					value={metadataValue}
					onChange={(e) => setMetadata(e.target.value)}
					placeholder="tier=premium, plan=pro"
					className={cn(
						"px-2 py-1 text-xs font-medium rounded-md border border-zinc-800 bg-canvas",
						"text-zinc-100 placeholder:text-zinc-600 w-48",
						"focus:outline-none focus:ring-1 focus:ring-blok-green-500",
					)}
				/>
			</div>

			{/* Saved Filters — preset combinations persisted to localStorage. */}
			<div className="flex items-center gap-2 ml-auto">
				<span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mr-1">Saved</span>
				<select
					value={savedSelected}
					onChange={(e) => handleApplySaved(e.target.value)}
					className={cn(
						"px-2 py-1 text-xs font-medium rounded-md border border-zinc-800 bg-canvas",
						"text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blok-green-500",
					)}
					aria-label="Apply saved filter"
				>
					<option value="">— Select —</option>
					{savedFilters.map((f) => (
						<option key={f.name} value={f.name}>
							{f.name}
						</option>
					))}
				</select>
				<button
					type="button"
					onClick={handleSaveCurrent}
					className={cn(
						"px-2 py-1 text-xs font-medium rounded-md border border-zinc-800 bg-canvas",
						"text-zinc-100 hover:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-blok-green-500",
					)}
					title="Save current filter as a preset"
				>
					Save
				</button>
				{savedSelected && (
					<button
						type="button"
						onClick={handleDeleteSelected}
						className={cn(
							"px-2 py-1 text-xs font-medium rounded-md border border-zinc-800 bg-canvas",
							"text-zinc-400 hover:bg-zinc-800 hover:text-red-400 focus:outline-none focus:ring-1 focus:ring-red-500",
						)}
						title={`Delete "${savedSelected}"`}
						aria-label={`Delete saved filter ${savedSelected}`}
					>
						✕
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * Parse a comma-separated tags input into the array shape expected by
 * `fetchRuns`. Empty string → undefined (no filter).
 */
export function parseTagsInput(input: string): string[] | undefined {
	const parts = input
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return parts.length > 0 ? parts : undefined;
}

/**
 * Parse a "k1=v1, k2=v2" metadata input into the record shape expected
 * by `fetchRuns`. Empty string → undefined (no filter). Malformed
 * entries (no `=`) are silently skipped.
 */
export function parseMetadataInput(input: string): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const piece of input.split(",")) {
		const trimmed = piece.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (key && value) result[key] = value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
