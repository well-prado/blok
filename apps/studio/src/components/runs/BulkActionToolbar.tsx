import { BulkActionBar } from "@/components/primitives/BulkActionBar";
import { Button } from "@/components/primitives/Buttons";
import { exportRunCsv, exportRunJson, replayRun } from "@/lib/api";
import type { WorkflowRun } from "@/types";
import { useNavigate } from "@tanstack/react-router";
import { Download, GitCompareArrows, RotateCcw } from "lucide-react";
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
 *
 * E2-T5 kept every one of those behaviours and replaced only the chrome:
 * the count/note/clear frame is now `primitives/BulkActionBar` and the
 * buttons are `primitives/Buttons`, so this file no longer hand-rolls raw
 * `zinc-*`/`blok-green-*` colors or uses `title=` as a label (banned by
 * `_design/CONVENTIONS.md` §9). Same export, same props, same visible text —
 * `RunsTable.tsx` changes nothing (§6.0).
 */
type Props = {
	/**
	 * Widened from `Set<string>` so `useTableSelection`'s `selected`
	 * (`ReadonlySet<string>`, §2.14) flows straight in. Type-only and
	 * source-compatible: every existing caller still passes a `Set`.
	 */
	selectedIds: ReadonlySet<string>;
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
		<BulkActionBar
			className="mb-4"
			count={selectedIds.size}
			onClear={onClear}
			note={
				replayable.length < selectedIds.size && (
					<span>· {selectedIds.size - replayable.length} non-HTTP, replay-skip</span>
				)
			}
		>
			{/* `<output>` rather than `role="status"` on a span: same implicit role, native
			    element, and biome's useSemanticElements rejects the role form (§9 forbids
			    suppressing it). Both were unannounced plain spans before. */}
			{progress && (
				<output className="text-xs tabular-nums text-ink-dimmed">
					{progress.done} / {progress.total} replayed
				</output>
			)}
			{error && <output className="text-xs text-status-failed-ink">{error}</output>}

			<Button
				size="sm"
				onClick={handleReplay}
				disabled={!canReplay}
				isLoading={status === "running"}
				leadingIcon={<RotateCcw />}
			>
				Replay {replayable.length > 0 && replayable.length}
			</Button>

			{canCompare && (
				<Button size="sm" onClick={handleCompare} leadingIcon={<GitCompareArrows />}>
					Compare
				</Button>
			)}

			<Button size="sm" onClick={() => handleExport("json")} leadingIcon={<Download />}>
				JSON
			</Button>
			<Button size="sm" onClick={() => handleExport("csv")} leadingIcon={<Download />}>
				CSV
			</Button>
		</BulkActionBar>
	);
}
