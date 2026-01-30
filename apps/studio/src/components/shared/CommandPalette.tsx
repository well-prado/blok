import { type SearchResponse, searchTraces } from "@/lib/api";
import { STATUS_DOT_COLORS } from "@/lib/constants";
import { formatDuration, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { WorkflowRun, WorkflowSummary } from "@/types";
import { useNavigate } from "@tanstack/react-router";
import { Activity, ArrowRight, Command, Search, Workflow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResponse>({ workflows: [], runs: [] });
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const navigate = useNavigate();

	const totalResults = results.workflows.length + results.runs.length;

	// Cmd+K to open
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setOpen((prev) => !prev);
			}
			if (e.key === "Escape" && open) {
				setOpen(false);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [open]);

	// Focus input on open
	useEffect(() => {
		if (open) {
			setQuery("");
			setResults({ workflows: [], runs: [] });
			setSelectedIndex(0);
			// Slight delay to ensure the input is mounted
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	// Debounced search
	useEffect(() => {
		if (!query.trim()) {
			setResults({ workflows: [], runs: [] });
			setSelectedIndex(0);
			return;
		}

		const timer = setTimeout(async () => {
			setLoading(true);
			try {
				const data = await searchTraces(query);
				setResults(data);
				setSelectedIndex(0);
			} catch {
				setResults({ workflows: [], runs: [] });
			} finally {
				setLoading(false);
			}
		}, 200);

		return () => clearTimeout(timer);
	}, [query]);

	const navigateToResult = useCallback(
		(index: number) => {
			const workflowCount = results.workflows.length;
			if (index < workflowCount) {
				const wf = results.workflows[index];
				if (wf) navigate({ to: "/workflows/$name", params: { name: wf.name } });
			} else {
				const run = results.runs[index - workflowCount];
				if (run) navigate({ to: "/runs/$runId", params: { runId: run.id } });
			}
			setOpen(false);
		},
		[results, navigate],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setSelectedIndex((prev) => (prev + 1) % Math.max(totalResults, 1));
				break;
			case "ArrowUp":
				e.preventDefault();
				setSelectedIndex((prev) => (prev - 1 + Math.max(totalResults, 1)) % Math.max(totalResults, 1));
				break;
			case "Enter":
				e.preventDefault();
				if (totalResults > 0) {
					navigateToResult(selectedIndex);
				}
				break;
		}
	};

	if (!open) return null;

	return (
		<>
			{/* Backdrop */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop overlay does not need keyboard interaction */}
			<div
				className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
				role="presentation"
				onClick={() => setOpen(false)}
			/>

			{/* Palette */}
			<div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] pointer-events-none">
				<dialog
					open
					className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden pointer-events-auto"
					aria-label="Search"
				>
					{/* Search input */}
					<div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
						<Search className="w-4 h-4 text-zinc-500 shrink-0" />
						<input
							ref={inputRef}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Search workflows, runs, errors..."
							className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none"
						/>
						<kbd className="hidden sm:inline-flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 border border-zinc-700">
							ESC
						</kbd>
					</div>

					{/* Results */}
					<div className="max-h-80 overflow-y-auto">
						{loading && query && <div className="px-4 py-6 text-center text-xs text-zinc-500">Searching...</div>}

						{!loading && query && totalResults === 0 && (
							<div className="px-4 py-6 text-center text-xs text-zinc-500">No results for "{query}"</div>
						)}

						{!loading && !query && (
							<div className="px-4 py-6 text-center text-xs text-zinc-500">
								Type to search workflows, runs, and errors
							</div>
						)}

						{/* Workflow results */}
						{results.workflows.length > 0 && (
							<div>
								<div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 bg-zinc-900/50">
									Workflows
								</div>
								{results.workflows.map((wf, i) => (
									<WorkflowResult
										key={wf.name}
										workflow={wf}
										selected={selectedIndex === i}
										onClick={() => navigateToResult(i)}
									/>
								))}
							</div>
						)}

						{/* Run results */}
						{results.runs.length > 0 && (
							<div>
								<div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 bg-zinc-900/50">
									Runs
								</div>
								{results.runs.map((run, i) => {
									const index = results.workflows.length + i;
									return (
										<RunResult
											key={run.id}
											run={run}
											selected={selectedIndex === index}
											onClick={() => navigateToResult(index)}
										/>
									);
								})}
							</div>
						)}
					</div>

					{/* Footer */}
					<div className="flex items-center gap-4 px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-600">
						<span className="flex items-center gap-1">
							<kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700">↑↓</kbd> Navigate
						</span>
						<span className="flex items-center gap-1">
							<kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700">↵</kbd> Open
						</span>
						<span className="flex items-center gap-1">
							<kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700">esc</kbd> Close
						</span>
					</div>
				</dialog>
			</div>
		</>
	);
}

function WorkflowResult({
	workflow,
	selected,
	onClick,
}: {
	workflow: WorkflowSummary;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
				selected ? "bg-zinc-800" : "hover:bg-zinc-800/50",
			)}
		>
			<Workflow className="w-4 h-4 text-zinc-500 shrink-0" />
			<div className="flex-1 min-w-0">
				<div className="text-sm text-zinc-200">{workflow.name}</div>
				<div className="text-[11px] text-zinc-500">
					{workflow.triggerTypes.join(", ")} · {workflow.totalRuns} runs · avg {formatDuration(workflow.avgDurationMs)}
				</div>
			</div>
			{selected && <ArrowRight className="w-3 h-3 text-zinc-500 shrink-0" />}
		</button>
	);
}

function RunResult({
	run,
	selected,
	onClick,
}: {
	run: WorkflowRun;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
				selected ? "bg-zinc-800" : "hover:bg-zinc-800/50",
			)}
		>
			<Activity className="w-4 h-4 text-zinc-500 shrink-0" />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<span className="text-sm text-zinc-200">{run.workflowName}</span>
					<span className="text-[11px] text-zinc-500 font-mono">{run.id.slice(0, 12)}</span>
					<span className={cn("w-2 h-2 rounded-full shrink-0", STATUS_DOT_COLORS[run.status])} />
				</div>
				<div className="text-[11px] text-zinc-500">
					{run.triggerSummary} · {formatDuration(run.durationMs)} · {formatRelativeTime(run.startedAt)}
					{run.error && <span className="text-red-400"> · {run.error.message.slice(0, 60)}</span>}
				</div>
			</div>
			{selected && <ArrowRight className="w-3 h-3 text-zinc-500 shrink-0" />}
		</button>
	);
}

/** Keyboard shortcut hint for the sidebar/header. */
export function CommandPaletteHint() {
	return (
		<div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
			<Command className="w-3 h-3" />
			<span>K</span>
		</div>
	);
}
