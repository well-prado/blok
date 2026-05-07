import { exportRunCsv, exportRunJson, replayRun } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { WorkflowRun } from "@/types";
import { useNavigate } from "@tanstack/react-router";
import { Download, GitCompareArrows, Loader2, RotateCcw, X } from "lucide-react";
import { useState } from "react";

/**
 * Floating toolbar for bulk actions on multi-selected runs · Direction A
 * · Phase 4. Renders when `selectedIds.size > 0`. Actions:
 *
 *   - Replay all   — loops `replayRun(id)` for HTTP-triggered runs in
 *                   the selection. Skips non-HTTP triggers (gRPC,
 *                   worker, cron) since the API doesn't support replay
 *                   for those yet. Navigates to the first replayed run
 *                   on success.
 *   - Compare      — only when exactly 2 are selected. Routes to the
 *                   existing /runs/diff page.
 *   - Export JSON  — kicks off N parallel downloads, one file per run.
 *                   Each is the run's full trace JSON.
 *   - Export CSV   — same but CSV per run.
 *   - Clear        — empties the selection set.
 *
 * Cancel / Delete are intentionally absent because the backend doesn't
 * expose per-run mutations for those yet (`clearRuns()` is global). When
 * those endpoints land, two more buttons drop into this toolbar.
 *
 * The toolbar lives at the top of the page (not floating in the
 * viewport). Operators told us they hate UIs that obscure data with
 * floating chrome — sticky-top is the same modality without the
 * occlusion.
 */
type Props = {
	selectedIds: Set<string>;
	runs: WorkflowRun[];
	onClear: () => void;
};

type Status = "idle" | "running";

export function BulkActionToolbar({ selectedIds, runs, onClear }: Props) {
	const navigate = useNavigate();
	const [status, setStatus] = useState<Status>("idle");
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (selectedIds.size === 0) return null;

	const selectedRuns = runs.filter((r) => selectedIds.has(r.id));
	const replayable = selectedRuns.filter((r) => r.triggerType === "http");
	const canReplay = replayable.length > 0 && status === "idle";
	const canCompare = selectedIds.size === 2;

	async function handleReplay() {
		if (!canReplay) return;
		setStatus("running");
		setError(null);
		setProgress({ done: 0, total: replayable.length });
		const results: { ok: boolean; newRunId?: string; err?: string }[] = [];

		// Sequential — replays mutate state on the trigger and a parallel
		// stampede across N HTTP requests can saturate it. N is bounded by
		// `selectedIds.size` (selection is human-driven).
		for (const run of replayable) {
			try {
				const r = await replayRun(run.id);
				results.push({ ok: true, newRunId: r.newRunId });
			} catch (e) {
				results.push({ ok: false, err: e instanceof Error ? e.message : String(e) });
			}
			setProgress({ done: results.length, total: replayable.length });
		}

		const firstSuccess = results.find((r) => r.ok && r.newRunId);
		const failedCount = results.filter((r) => !r.ok).length;

		setStatus("idle");
		setProgress(null);
		if (failedCount > 0) {
			setError(`${failedCount} of ${replayable.length} replays failed.`);
		}
		if (firstSuccess?.newRunId) {
			onClear();
			navigate({ to: "/runs/$runId", params: { runId: firstSuccess.newRunId } });
		}
	}

	function handleCompare() {
		if (!canCompare) return;
		const [a, b] = [...selectedIds];
		if (a && b) navigate({ to: "/runs/diff", search: { a, b } });
	}

	function handleExport(kind: "json" | "csv") {
		// Delegate to existing per-run export functions. Each kicks off a
		// download in the browser; modern browsers handle N concurrent
		// downloads gracefully but we cap at 20 to be polite.
		const targets = [...selectedIds].slice(0, 20);
		for (const id of targets) {
			if (kind === "json") exportRunJson(id);
			else exportRunCsv(id);
		}
	}

	return (
		<div className="rounded-lg border border-blok-green-500/30 bg-blok-green-500/10 px-3 py-2 flex items-center gap-3 mb-4">
			<span className="font-mono text-[11px] text-blok-green-500 font-semibold">{selectedIds.size} selected</span>
			{replayable.length < selectedIds.size && (
				<span className="font-mono text-[10.5px] text-zinc-500">
					· {selectedIds.size - replayable.length} non-HTTP, replay-skip
				</span>
			)}

			<div className="ml-auto flex items-center gap-2">
				{progress && (
					<span className="font-mono text-[11px] text-zinc-400">
						{progress.done} / {progress.total} replayed
					</span>
				)}
				{error && <span className="font-mono text-[11px] text-status-failed">{error}</span>}

				<ToolbarButton
					onClick={handleReplay}
					disabled={!canReplay}
					title={
						canReplay
							? `Replay ${replayable.length} HTTP-triggered runs`
							: status === "running"
								? "Replay in progress…"
								: "No HTTP-triggered runs in selection"
					}
				>
					{status === "running" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
					Replay {replayable.length > 0 && replayable.length}
				</ToolbarButton>

				{canCompare && (
					<ToolbarButton onClick={handleCompare} title="Compare the two selected runs side-by-side">
						<GitCompareArrows className="w-3 h-3" />
						Compare
					</ToolbarButton>
				)}

				<ToolbarButton onClick={() => handleExport("json")} title="Download a JSON file per selected run (up to 20)">
					<Download className="w-3 h-3" />
					JSON
				</ToolbarButton>
				<ToolbarButton onClick={() => handleExport("csv")} title="Download a CSV file per selected run (up to 20)">
					<Download className="w-3 h-3" />
					CSV
				</ToolbarButton>

				<button
					type="button"
					onClick={onClear}
					className="p-1 rounded text-zinc-500 hover:text-zinc-100 hover:bg-hover transition-colors"
					title="Clear selection · Esc"
					aria-label="Clear selection"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
	);
}

function ToolbarButton({
	children,
	onClick,
	disabled,
	title,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={cn(
				"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium border transition-colors",
				disabled
					? "bg-raised border-zinc-800 text-zinc-600 cursor-not-allowed"
					: "bg-raised border-zinc-800 text-zinc-200 hover:bg-hover hover:text-zinc-100",
			)}
		>
			{children}
		</button>
	);
}
