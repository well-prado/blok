import { type LogsResponse, fetchLogs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useEnvScope } from "@/stores/envScope";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Logs · Direction A · Phase 3 (greenfield).
 *
 * Cross-run log feed with token-chip filtering and a live-tail toggle —
 * the screen Studio didn't have before. Replaces the per-run-only log
 * view with a workflow-spanning grep, so during an incident operators
 * don't have to know which run-id to open before they can search.
 *
 * Filters: level chips (multi-select), workflow filter chip, free-text
 * substring search. Token chips render inline in the search bar so the
 * mental model is "this query is the union of these chips and the
 * text". Clearing a chip removes its filter; clearing the text input
 * removes the substring filter.
 *
 * Live tail (`L` to toggle): when on, refetches on a 2-second poll
 * with `since=<lastTimestamp>` so newly-arrived rows flash brand-green
 * for 1.2s and the table auto-scrolls. When off, the page is
 * snapshot-stable for in-depth investigation.
 *
 * Pagination is intentionally one-page-deep (limit=200, server can
 * return up to 1000). For deeper history operators jump into a
 * specific run via the `Run` column → `routes/runs/$runId`.
 */
export const Route = createFileRoute("/logs")({
	component: LogsPage,
});

const ALL_LEVELS = ["error", "warn", "info", "debug"] as const;
type Level = (typeof ALL_LEVELS)[number];

function LogsPage() {
	const env = useEnvScope((s) => s.current);
	const [activeLevels, setActiveLevels] = useState<Set<Level>>(new Set());
	const [workflowFilter, setWorkflowFilter] = useState<string | undefined>();
	const [q, setQ] = useState("");
	const [tail, setTail] = useState(true);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const levelParam = activeLevels.size > 0 ? [...activeLevels].join(",") : undefined;

	// Snapshot fetch — when tail is off this is the truth. When tail is
	// on we set a refetchInterval to poll new logs (cheap; the endpoint
	// caps result size).
	const { data, isLoading, error } = useQuery<LogsResponse>({
		queryKey: ["logs", env, levelParam, workflowFilter, q, tail],
		queryFn: () =>
			fetchLogs({
				workflow: workflowFilter,
				level: levelParam,
				q: q || undefined,
				env,
				limit: 200,
			}),
		refetchInterval: tail ? 2000 : false,
		// Keep last data while refetching so live tail doesn't flicker
		// the table off and back on.
		placeholderData: (prev) => prev,
	});

	// Track new ids so just-arrived rows can flash brand-green for 1.2s
	const seenIdsRef = useRef<Set<string>>(new Set());
	const [newIds, setNewIds] = useState<Set<string>>(new Set());
	useEffect(() => {
		if (!data?.logs) return;
		const fresh = data.logs.filter((l) => !seenIdsRef.current.has(l.id));
		for (const l of fresh) seenIdsRef.current.add(l.id);
		if (fresh.length === 0) return;
		const ids = new Set(fresh.map((l) => l.id));
		setNewIds(ids);
		const t = setTimeout(() => setNewIds(new Set()), 1200);
		return () => clearTimeout(t);
	}, [data]);

	// Workflows + counts for the stats row.
	const stats = useMemo(() => {
		const counts: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0 };
		const wfs = new Set<string>();
		for (const l of data?.logs ?? []) {
			counts[l.level] = (counts[l.level] ?? 0) + 1;
			wfs.add(l.workflowName);
		}
		return { counts, workflowCount: wfs.size };
	}, [data?.logs]);

	// Keyboard: `/` focus search, `L` toggle tail, `Esc` clear search input
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
				if (e.key === "Escape") {
					setQ("");
					(e.target as HTMLInputElement).blur();
				}
				return;
			}
			if (e.metaKey || e.ctrlKey) return;
			if (e.key === "/") {
				e.preventDefault();
				inputRef.current?.focus();
			} else if (e.key.toLowerCase() === "l") {
				setTail((v) => !v);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	const toggleLevel = (lvl: Level) => {
		setActiveLevels((prev) => {
			const next = new Set(prev);
			if (next.has(lvl)) next.delete(lvl);
			else next.add(lvl);
			return next;
		});
	};

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<header className="px-6 pt-5 pb-3 border-b border-zinc-800 bg-canvas">
				<div className="flex items-baseline gap-3 mb-1">
					<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">Logs</h1>
					<span className="text-[12px] font-mono text-zinc-500">
						{env} · {workflowFilter ?? "all workflows"}
					</span>
					<button
						type="button"
						onClick={() => setTail((v) => !v)}
						className={cn(
							"ml-auto inline-flex items-center gap-2 px-3 py-1 rounded-md border text-xs font-medium transition-colors",
							tail
								? "bg-blok-green-500/10 text-blok-green-500 border-blok-green-500/30"
								: "bg-raised text-zinc-400 border-zinc-800 hover:bg-hover",
						)}
						aria-pressed={tail}
					>
						<span className={cn("w-1.5 h-1.5 rounded-full bg-current", tail && "animate-pulse-dot")} />
						Live tail
						<kbd className="font-mono text-[10px] px-1 py-px rounded bg-canvas border border-zinc-800 text-zinc-500">
							L
						</kbd>
					</button>
				</div>

				{/* Search bar with token chips */}
				<div className="mt-3 flex items-center gap-2 bg-raised border border-zinc-800 rounded-lg px-3 py-1.5 focus-within:border-blok-green-500 focus-within:shadow-[0_0_0_3px_rgba(43,205,113,0.12)] transition-all">
					<Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
					{[...activeLevels].map((lvl) => (
						<Chip key={lvl} k="level:" v={lvl} onRemove={() => toggleLevel(lvl)} />
					))}
					{workflowFilter && <Chip k="workflow:" v={workflowFilter} onRemove={() => setWorkflowFilter(undefined)} />}
					<input
						ref={inputRef}
						className="flex-1 bg-transparent border-0 outline-none text-zinc-100 font-mono text-[12px] py-1 min-w-[120px]"
						placeholder='message ~ "ConnectionRefused"  ·  /  to focus'
						value={q}
						onChange={(e) => setQ(e.target.value)}
					/>
					{q && (
						<button
							type="button"
							onClick={() => setQ("")}
							className="text-zinc-500 hover:text-zinc-100 p-0.5"
							aria-label="Clear search"
						>
							<X className="w-3 h-3" />
						</button>
					)}
				</div>

				{/* Stats row */}
				<div className="flex items-center gap-4 mt-2.5 text-[11.5px] font-mono text-zinc-500">
					<span>
						<span className="text-zinc-100 font-medium">{data?.logs.length ?? 0}</span> matched
						{data?.truncated && <span className="text-amber-400 ml-1">· truncated</span>}
					</span>
					<span>·</span>
					<LevelButton
						lvl="error"
						active={activeLevels.has("error")}
						count={stats.counts.error}
						onClick={toggleLevel}
					/>
					<LevelButton lvl="warn" active={activeLevels.has("warn")} count={stats.counts.warn} onClick={toggleLevel} />
					<LevelButton lvl="info" active={activeLevels.has("info")} count={stats.counts.info} onClick={toggleLevel} />
					<LevelButton
						lvl="debug"
						active={activeLevels.has("debug")}
						count={stats.counts.debug}
						onClick={toggleLevel}
					/>
					<span className="ml-auto">
						<span className="text-zinc-100 font-medium">{stats.workflowCount}</span> workflows
					</span>
				</div>
			</header>

			{/* Table */}
			<div className="flex-1 overflow-y-auto bg-canvas">
				{isLoading && !data && <div className="p-8 text-sm text-zinc-500">Loading logs…</div>}
				{error && (
					<div className="p-8 text-sm text-red-400">
						Failed to load logs. Is the runner trace API at <code className="font-mono">/__blok/logs</code> running?
					</div>
				)}
				{data && data.logs.length === 0 && (
					<div className="p-8 text-sm text-zinc-500">
						No logs match these filters.{" "}
						{tail && "Live tail is on — new matches will flash brand-green when they land."}
					</div>
				)}
				{data && data.logs.length > 0 && (
					<table className="w-full font-mono text-[12px]">
						<thead className="sticky top-0 bg-overlay z-10">
							<tr>
								<Th className="w-[130px]">Time</Th>
								<Th className="w-[72px]">Level</Th>
								<Th className="w-[200px]">Workflow</Th>
								<Th className="w-[150px]">Step</Th>
								<Th>Message</Th>
								<Th className="w-[116px]">Run</Th>
							</tr>
						</thead>
						<tbody>
							{data.logs.map((log) => (
								<tr
									key={log.id}
									className={cn(
										"border-b border-zinc-800 hover:bg-hover transition-colors",
										newIds.has(log.id) && "row-flash",
									)}
								>
									<td className="px-3 py-1.5 text-zinc-500 whitespace-nowrap">
										{new Date(log.timestamp).toISOString().slice(11, 23)}
									</td>
									<td className="px-3 py-1.5">
										<LevelBadge level={log.level} />
									</td>
									<td className="px-3 py-1.5 text-zinc-300">
										<button
											type="button"
											onClick={() =>
												setWorkflowFilter(log.workflowName === workflowFilter ? undefined : log.workflowName)
											}
											className={cn(
												"hover:text-zinc-100 hover:underline truncate max-w-full text-left",
												workflowFilter === log.workflowName && "text-blok-green-500",
											)}
											title={`Filter by ${log.workflowName}`}
										>
											{log.workflowName}
										</button>
									</td>
									<td className="px-3 py-1.5 text-zinc-400 truncate">{log.nodeName ?? "—"}</td>
									<td className="px-3 py-1.5 text-zinc-100 break-words">{log.message}</td>
									<td className="px-3 py-1.5 whitespace-nowrap">
										<Link
											to="/runs/$runId"
											params={{ runId: log.runId }}
											className="text-blok-green-500 hover:text-blok-green-600 hover:underline"
										>
											{log.runId.slice(0, 12)}
										</Link>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{/* Footer */}
			<footer className="px-6 py-2 bg-overlay border-t border-zinc-800 flex items-center gap-4 text-[11px] font-mono text-zinc-500">
				{tail ? (
					<span className="inline-flex items-center gap-1.5 text-blok-green-500">
						<span className="w-1.5 h-1.5 rounded-full bg-blok-green-500 animate-pulse-dot" />
						tailing
					</span>
				) : (
					<span>paused</span>
				)}
				<span>·</span>
				<span>
					<span className="text-zinc-100 font-medium">{data?.logs.length ?? 0}</span> events shown
				</span>
				{data?.truncated && <span className="text-amber-400">· capped at server limit (200)</span>}
				<span className="ml-auto text-zinc-600">/ to focus search · L toggle tail · Esc clear</span>
			</footer>

			{/* row-flash keyframe — colocated with the route since this is
			    the only place it's used. */}
			<style>{`@keyframes row-flash { 0% { background: rgba(43, 205, 113, 0.18); } 100% { background: transparent; } }
				.row-flash { animation: row-flash 1.2s ease-out; }`}</style>
		</div>
	);
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Chip({ k, v, onRemove }: { k: string; v: string; onRemove: () => void }) {
	return (
		<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-overlay border border-zinc-800 text-[11px] text-zinc-300">
			<span className="text-zinc-500">{k}</span>
			<span>{v}</span>
			<button
				type="button"
				onClick={onRemove}
				className="text-zinc-500 hover:text-zinc-100 ml-0.5"
				aria-label={`Remove ${k}${v} filter`}
			>
				<X className="w-2.5 h-2.5" />
			</button>
		</span>
	);
}

function LevelButton({
	lvl,
	active,
	count,
	onClick,
}: { lvl: Level; active: boolean; count: number; onClick: (l: Level) => void }) {
	const levelText = {
		error: "text-log-error",
		warn: "text-log-warn",
		info: "text-log-info",
		debug: "text-log-debug",
	}[lvl];
	return (
		<button
			type="button"
			onClick={() => onClick(lvl)}
			className={cn(
				"inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors",
				active ? "bg-hover text-zinc-100" : "hover:bg-hover hover:text-zinc-300",
			)}
		>
			<span className="text-zinc-500">{lvl}</span>
			<span className={cn("font-medium", count > 0 ? levelText : "text-zinc-600")}>{count}</span>
		</button>
	);
}

function LevelBadge({ level }: { level: Level }) {
	const styles: Record<Level, string> = {
		error: "bg-red-500/15 text-log-error",
		warn: "bg-amber-500/15 text-log-warn",
		info: "bg-blue-500/15 text-log-info",
		debug: "bg-zinc-700/40 text-log-debug",
	};
	return (
		<span
			className={cn(
				"inline-block px-1.5 py-0.5 rounded text-[9.5px] font-semibold uppercase tracking-[0.04em] min-w-[50px] text-center",
				styles[level],
			)}
		>
			{level}
		</span>
	);
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<th
			className={cn(
				"text-left text-[10px] uppercase tracking-[0.06em] text-zinc-500 font-semibold px-3 py-2 border-b border-zinc-800",
				className,
			)}
		>
			{children}
		</th>
	);
}
