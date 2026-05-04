/*
 * Blok Studio mock components — visual previews for docs.
 *
 * These mirror the real components in `apps/studio/src/` so screenshots
 * never go stale: the docs UI tracks whatever the real Studio renders.
 * Brand green is `#39C068` (matches the `blok-green-500` token in
 * Studio's Tailwind config). Stock Tailwind utility classes only;
 * brand-specific values use inline `style`.
 */

const BRAND_GREEN = "#39C068";
const BRAND_GREEN_BG = "rgba(57,192,104,0.10)";
const BRAND_GREEN_BORDER = "rgba(57,192,104,0.30)";
const BRAND_GREEN_TEXT = "#73D997";

const STATUS_DOT = {
	pending: "bg-zinc-400",
	running: "bg-blue-400",
	completed: "bg-green-400",
	failed: "bg-red-400",
	cancelled: "bg-purple-400",
	skipped: "bg-zinc-500",
	throttled: "bg-amber-300",
	delayed: "bg-yellow-400",
	expired: "bg-zinc-500",
	debounced: "bg-cyan-400",
	queued: "bg-lime-300",
	crashed: "bg-red-500",
	timedOut: "bg-orange-400",
};

/* Single Studio chrome wrapper — gives all mocks the dark Studio look. */
export const StudioFrame = ({ title = "Blok Studio", children }) => (
	<div className="not-prose my-6 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950 shadow-lg font-sans">
		<div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900">
			<div className="flex gap-1.5">
				<span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
				<span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
				<span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
			</div>
			<span className="text-[11px] text-zinc-500 font-mono ml-2">{title}</span>
		</div>
		<div className="p-4 text-zinc-200 text-sm">{children}</div>
	</div>
);

/* Run header — workflow name, status, replay-of breadcrumb, parent breadcrumb,
   action buttons. Mirrors $runId.tsx:160-260. */
export const StudioRunHeader = ({
	workflowName = "ai-content-pipeline",
	runId = "run_4f3a2c1b9e",
	status = "completed",
	durationMs = 2143,
	triggerSummary = "POST /generate",
	startedAt = "2026-05-03 10:42:15",
	nodeCount = 4,
	completedNodes = 4,
	replayOf = null,
	parentRunId = null,
	showReplayButton = true,
	subRuns = [],
}) => {
	const dot = STATUS_DOT[status] ?? STATUS_DOT.completed;
	return (
		<StudioFrame title={`Studio · ${workflowName}`}>
			<div className="flex items-center gap-3">
				<span className={`w-2 h-2 rounded-full ${dot}`} />
				<span className="text-zinc-100 font-semibold tracking-tight">{workflowName}</span>
				<span className="text-zinc-600 font-mono text-xs">{runId}</span>
				<span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
					{status}
				</span>
				<span className="font-mono text-xs text-zinc-500">{(durationMs / 1000).toFixed(2)}s</span>

				{replayOf && (
					<button
						type="button"
						onClick={(e) => e.preventDefault()}
						title={`Replay of run ${replayOf}`}
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
					>
						<span aria-hidden>⟳</span>
						replay of {replayOf.slice(0, 8)}
					</button>
				)}
				{parentRunId && (
					<button
						type="button"
						onClick={(e) => e.preventDefault()}
						title={`Called from run ${parentRunId}`}
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
					>
						<span aria-hidden>⎇</span>
						called from {parentRunId.slice(0, 8)}
					</button>
				)}

				{showReplayButton && (
					<button
						type="button"
						className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
						onClick={(e) => e.preventDefault()}
						title="Replay this run with the same request"
					>
						<span aria-hidden>⟳</span> Replay
					</button>
				)}
			</div>

			<div className="flex items-center gap-4 text-xs text-zinc-500 mt-2 pl-5">
				<span>
					Trigger: <span className="text-zinc-400 font-mono">{triggerSummary}</span>
				</span>
				<span>
					Started: <span className="text-zinc-400">{startedAt}</span>
				</span>
				<span>
					Nodes:{" "}
					<span className="text-zinc-400">
						{completedNodes}/{nodeCount}
					</span>
				</span>
			</div>

			{subRuns.length > 0 && (
				<div className="pl-5 mt-3 flex items-center gap-2 text-[11px] text-zinc-500 flex-wrap">
					<span className="flex items-center gap-1 uppercase tracking-wide font-semibold text-zinc-500">
						<span aria-hidden>⎇</span>
						sub-runs ({subRuns.length})
					</span>
					{subRuns.map((sub) => (
						<button
							key={sub.id}
							type="button"
							onClick={(e) => e.preventDefault()}
							title={`${sub.workflowName} · ${sub.status}`}
							className="flex items-center gap-1.5 px-1.5 py-0.5 rounded font-mono bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
						>
							<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[sub.status] ?? STATUS_DOT.completed}`} />
							{sub.workflowName}
							<span className="text-zinc-600">{sub.id.slice(0, 8)}</span>
						</button>
					))}
				</div>
			)}
		</StudioFrame>
	);
};

/* Step rail — left-pane vertical step list. Mirrors StepRail.tsx. */
export const StudioStepRail = ({ steps = [], activeIndex = 0 }) => {
	const failed = steps.filter((s) => s.status === "failed").length;
	const completed = steps.filter((s) => s.status === "completed").length;
	return (
		<StudioFrame title="Studio · steps">
			<div className="bg-zinc-950 border border-zinc-800 rounded-md overflow-hidden w-[320px] max-w-full">
				<div className="px-4 pt-2 pb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold">
					<span>Steps</span>
					<span className={`font-mono normal-case tracking-normal ${failed > 0 ? "text-red-400" : "text-zinc-400"}`}>
						{failed > 0 ? `${failed} failed` : `${completed} / ${steps.length}`}
					</span>
				</div>
				<ul className="m-0 p-0 list-none">
					{steps.map((s, i) => {
						const active = i === activeIndex;
						const dot = STATUS_DOT[s.status] ?? STATUS_DOT.completed;
						return (
							<li key={s.id} className="m-0">
								<div
									className={`relative w-full flex items-center gap-2.5 pl-4 pr-3 py-1.5 text-[12.5px] text-left ${
										active ? "text-zinc-100" : "text-zinc-400"
									}`}
									style={
										active ? { background: BRAND_GREEN_BG, boxShadow: `inset 2px 0 0 0 ${BRAND_GREEN}` } : undefined
									}
								>
									<span className="font-mono text-[10px] text-zinc-600 w-3 shrink-0">{i + 1}</span>
									<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
									<span className="flex-1 truncate">{s.name}</span>
									{s.subworkflow && s.wait !== false && (
										<span
											className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-zinc-700/40 text-zinc-300 shrink-0"
											title="Sub-workflow invocation (synchronous) — see Sub-runs in the header"
										>
											↳ sub
										</span>
									)}
									{s.subworkflow && s.wait === false && (
										<span
											className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded bg-orange-300/15 text-orange-300 shrink-0"
											title="Async sub-workflow (fire-and-forget) — child runs independently; parent does NOT block"
										>
											↳ async
										</span>
									)}
									{s.cached && (
										<span
											className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded shrink-0"
											style={{ background: "rgba(57,192,104,0.15)", color: BRAND_GREEN }}
											title="Reused result from cache"
										>
											cached
										</span>
									)}
									{s.attempts > 0 && (
										<span
											className="font-mono text-[9px] px-1 py-px rounded bg-amber-400/15 text-amber-400 shrink-0"
											title={`${s.attempts} failed attempts before outcome`}
										>
											↻{s.attempts}
										</span>
									)}
									{s.durationMs != null && (
										<span
											className={`font-mono text-[10.5px] shrink-0 ${
												s.status === "failed" ? "text-red-400" : active ? "text-zinc-300" : "text-zinc-600"
											}`}
										>
											{s.durationMs < 1000 ? `${s.durationMs} ms` : `${(s.durationMs / 1000).toFixed(2)} s`}
										</span>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			</div>
		</StudioFrame>
	);
};

/* Cache lineage banner — highest-priority body element when a step
   short-circuits via the idempotency cache. Mirrors ActiveStepPanel.tsx:81-101. */
export const StudioCacheBanner = ({ sourceRunId = "run_8a92c4f01b", cachedAgoSec = 142 }) => (
	<StudioFrame title="Studio · step detail">
		<div
			className="flex items-start gap-3 rounded-md px-4 py-3"
			style={{ border: `1px solid ${BRAND_GREEN_BORDER}`, background: "rgba(57,192,104,0.05)" }}
		>
			<span
				className="font-mono text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 mt-0.5"
				style={{ background: "rgba(57,192,104,0.15)", color: BRAND_GREEN }}
			>
				cached
			</span>
			<div className="text-[12px] text-zinc-300 leading-relaxed">
				This step short-circuited via the idempotency cache.
				<div className="mt-1 text-zinc-500 font-mono text-[11px]">
					source run{" "}
					<button
						type="button"
						onClick={(e) => e.preventDefault()}
						className="text-zinc-300 underline decoration-zinc-700 bg-transparent p-0 cursor-pointer"
					>
						{sourceRunId}
					</button>{" "}
					· cached {cachedAgoSec}s ago
				</div>
			</div>
		</div>
	</StudioFrame>
);

/* Attempts disclosure — per-attempt failure history.
   Mirrors ActiveStepPanel.tsx:107-127. */
export const StudioAttemptsDisclosure = ({
	attempts = [
		{ attempt: 1, timestamp: "10:42:15.001", error: "ECONNRESET — upstream reset connection" },
		{ attempt: 2, timestamp: "10:42:16.512", error: "503 Service Unavailable" },
	],
	open = true,
}) => (
	<StudioFrame title="Studio · step detail">
		<details open={open} className="rounded-md px-4 py-3 border border-amber-400/30 bg-amber-400/5">
			<summary className="cursor-pointer text-[12px] text-zinc-200 font-medium select-none list-none">
				<span className="font-mono text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 mr-2">
					retry
				</span>
				{attempts.length} failed attempt{attempts.length === 1 ? "" : "s"} before outcome
			</summary>
			<ul className="mt-3 space-y-2 text-[11.5px] m-0 p-0 list-none">
				{attempts.map((a) => (
					<li key={a.attempt} className="flex items-start gap-3 font-mono m-0">
						<span className="text-zinc-500 shrink-0">#{a.attempt}</span>
						<span className="text-zinc-500 shrink-0">{a.timestamp}</span>
						<span className="text-red-400 wrap-break-word">{a.error}</span>
					</li>
				))}
			</ul>
		</details>
	</StudioFrame>
);

/* Event timeline — list of run events with label + color.
   Mirrors EVENT_LABELS / EVENT_COLORS in apps/studio/src/lib/constants.ts. */
const EVENT_STYLES = {
	RUN_STARTED: { label: "Run Started", className: "text-blue-400 bg-blue-400/10" },
	RUN_COMPLETED: { label: "Run Completed", className: "text-green-400 bg-green-400/10" },
	RUN_FAILED: { label: "Run Failed", className: "text-red-400 bg-red-400/10" },
	NODE_STARTED: { label: "Node Started", className: "text-blue-300 bg-blue-300/10" },
	NODE_COMPLETED: { label: "Node Completed", className: "text-green-300 bg-green-300/10" },
	NODE_FAILED: { label: "Node Failed", className: "text-red-300 bg-red-300/10" },
	NODE_SKIPPED: { label: "Node Skipped", className: "text-zinc-400 bg-zinc-400/10" },
	NODE_PROGRESS: { label: "Node Progress", className: "text-cyan-400 bg-cyan-400/10" },
	NODE_PARTIAL_RESULT: { label: "Node Partial Result", className: "text-cyan-300 bg-cyan-300/10" },
	NODE_CACHED: { label: "Node Cached", className: "text-emerald-400 bg-emerald-400/10" },
	NODE_ATTEMPT_FAILED: { label: "Attempt Failed", className: "text-amber-400 bg-amber-400/10" },
	VARS_UPDATED: { label: "Vars Updated", className: "text-yellow-400 bg-yellow-400/10" },
	LOG_ENTRY: { label: "Log Entry", className: "text-zinc-300 bg-zinc-300/10" },
	RUN_THROTTLED: { label: "Run Throttled", className: "text-amber-300 bg-amber-300/10" },
	RUN_DELAYED: { label: "Run Delayed", className: "text-yellow-400 bg-yellow-400/10" },
	RUN_EXPIRED: { label: "Run Expired", className: "text-zinc-500 bg-zinc-500/10" },
	RUN_DEBOUNCED: { label: "Run Debounced", className: "text-cyan-400 bg-cyan-400/10" },
	RUN_QUEUED: { label: "Run Queued", className: "text-lime-300 bg-lime-300/10" },
	RUN_CANCELLED: { label: "Run Cancelled", className: "text-purple-400 bg-purple-400/10" },
	RUN_CRASHED: { label: "Run Crashed", className: "text-red-500 bg-red-500/10" },
	RUN_TIMED_OUT: { label: "Run Timed Out", className: "text-orange-400 bg-orange-400/10" },
};

export const StudioEventTimeline = ({ events = [] }) => (
	<StudioFrame title="Studio · events">
		<ul className="m-0 p-0 list-none space-y-1.5">
			{events.map((e) => {
				const meta = EVENT_STYLES[e.type] ?? { label: e.type, className: "text-zinc-300 bg-zinc-700/30" };
				return (
					<li key={`${e.timestamp}-${e.type}`} className="flex items-center gap-3 m-0">
						<span className="font-mono text-[10.5px] text-zinc-500 w-20 shrink-0">{e.timestamp}</span>
						<span
							className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${meta.className} shrink-0`}
						>
							{meta.label}
						</span>
						<span className="text-[12px] text-zinc-300 truncate">{e.summary}</span>
					</li>
				);
			})}
		</ul>
	</StudioFrame>
);

/* Single inline event badge — useful in tables and inline references. */
export const StudioEventBadge = ({ type }) => {
	const meta = EVENT_STYLES[type] ?? { label: type, className: "text-zinc-300 bg-zinc-700/30" };
	return (
		<span className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${meta.className}`}>
			{meta.label}
		</span>
	);
};

/* Sub-runs strip — shown standalone for the sub-workflow page when we
   want to highlight the strip without the rest of the header. */
export const StudioSubRunsStrip = ({
	subRuns = [
		{ id: "run_a91c2fe", workflowName: "validate-payment", status: "completed" },
		{ id: "run_b73e442", workflowName: "send-receipt-email", status: "completed" },
	],
}) => (
	<StudioFrame title="Studio · sub-runs">
		<div className="flex items-center gap-2 text-[11px] text-zinc-500 flex-wrap">
			<span className="flex items-center gap-1 uppercase tracking-wide font-semibold text-zinc-500">
				<span aria-hidden>⎇</span>
				sub-runs ({subRuns.length})
			</span>
			{subRuns.map((sub) => (
				<button
					key={sub.id}
					type="button"
					onClick={(e) => e.preventDefault()}
					title={`${sub.workflowName} · ${sub.status}`}
					className="flex items-center gap-1.5 px-1.5 py-0.5 rounded font-mono bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
				>
					<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[sub.status] ?? STATUS_DOT.completed}`} />
					{sub.workflowName}
					<span className="text-zinc-600">{sub.id.slice(0, 8)}</span>
				</button>
			))}
		</div>
	</StudioFrame>
);

/* In-flight concurrency tile — header strip on the All Runs page when
   any concurrency slots are in flight. Mirrors ConcurrencyTile.tsx. */
export const StudioConcurrencyTile = ({
	backendName = "in-process",
	totalLeases = 7,
	totalBuckets = 2,
	buckets = [
		{ workflowName: "render-pdf", concurrencyKey: "tenant-a", inFlight: 5 },
		{ workflowName: "checkout", concurrencyKey: "cart-42", inFlight: 2 },
	],
}) => (
	<StudioFrame title="Studio · all runs">
		<div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
			<div className="flex items-center gap-2 mb-2">
				<span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">In-flight slots</span>
				<span className="font-mono text-[11px] text-zinc-300">{totalLeases}</span>
				<span className="text-zinc-600 text-[11px]">across {totalBuckets} buckets</span>
				{backendName !== "in-process" && (
					<span
						className="ml-auto font-mono text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
						style={{ background: "rgba(57,192,104,0.15)", color: BRAND_GREEN }}
						title={`Concurrency backend: ${backendName}`}
					>
						{backendName}
					</span>
				)}
			</div>
			<ul className="m-0 p-0 list-none space-y-1">
				{buckets.map((b) => (
					<li
						key={`${b.workflowName}\x1f${b.concurrencyKey}`}
						className="flex items-center gap-3 text-[11.5px] m-0 font-mono"
					>
						<span className="text-zinc-300 truncate flex-1">{b.workflowName}</span>
						<span className="text-zinc-500 truncate">{b.concurrencyKey}</span>
						<span className="text-amber-300 shrink-0 w-10 text-right">{b.inFlight} ⟳</span>
					</li>
				))}
			</ul>
		</div>
	</StudioFrame>
);

/* Saved Filters dropdown — preset filter combinations a user can save. */
export const StudioSavedFilters = ({
	presets = [
		{ name: "Failures last hour", active: false },
		{ name: "Tenant A premium", active: true },
		{ name: "Throttled today", active: false },
	],
}) => (
	<StudioFrame title="Studio · runs filter">
		<div className="flex items-center gap-3 flex-wrap">
			<span className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">Saved</span>
			<div className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 flex items-center gap-1.5">
				{presets.map((p) => (
					<button
						key={p.name}
						type="button"
						onClick={(e) => e.preventDefault()}
						className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${
							p.active ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"
						}`}
					>
						{p.name}
					</button>
				))}
				<span className="text-zinc-700">·</span>
				<button
					type="button"
					onClick={(e) => e.preventDefault()}
					className="text-[11px] text-zinc-500 hover:text-zinc-100 px-1.5 py-0.5 rounded font-mono"
					title="Save current filter combination"
				>
					+ save
				</button>
			</div>
			<span className="text-[11px] text-zinc-600">localStorage · per-browser</span>
		</div>
	</StudioFrame>
);

/* Two-step diagram — "before" (cache miss) vs "after" (cache hit) for
   the idempotency page. Pure visual storytelling. */
export const StudioCacheFlow = () => (
	<div className="not-prose my-6 grid md:grid-cols-2 gap-4">
		<div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
			<div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 font-mono">First request</div>
			<ol className="space-y-2 text-[12.5px] m-0 p-0 list-none">
				<li className="flex items-center gap-2 m-0">
					<span className="w-1.5 h-1.5 rounded-full bg-green-400" />
					<span className="text-zinc-300">draft</span>
					<span className="text-zinc-500 font-mono text-[11px] ml-auto">1.2s · executed</span>
				</li>
				<li className="flex items-center gap-2 m-0">
					<span className="w-1.5 h-1.5 rounded-full bg-green-400" />
					<span className="text-zinc-300">respond</span>
					<span className="text-zinc-500 font-mono text-[11px] ml-auto">8 ms</span>
				</li>
			</ol>
			<div className="mt-3 text-[11px] text-zinc-500">Cache write on success</div>
		</div>
		<div className="rounded-lg p-4" style={{ border: `1px solid ${BRAND_GREEN_BORDER}`, background: BRAND_GREEN_BG }}>
			<div className="text-[10px] uppercase tracking-wider mb-2 font-mono" style={{ color: BRAND_GREEN }}>
				Second request — same idempotencyKey
			</div>
			<ol className="space-y-2 text-[12.5px] m-0 p-0 list-none">
				<li className="flex items-center gap-2 m-0">
					<span className="w-1.5 h-1.5 rounded-full" style={{ background: BRAND_GREEN }} />
					<span className="text-zinc-300">draft</span>
					<span
						className="font-mono text-[9px] uppercase tracking-wide px-1 py-px rounded ml-auto"
						style={{ background: "rgba(57,192,104,0.15)", color: BRAND_GREEN }}
					>
						cached
					</span>
					<span className="text-zinc-500 font-mono text-[11px]">2 ms</span>
				</li>
				<li className="flex items-center gap-2 m-0">
					<span className="w-1.5 h-1.5 rounded-full bg-green-400" />
					<span className="text-zinc-300">respond</span>
					<span className="text-zinc-500 font-mono text-[11px] ml-auto">7 ms</span>
				</li>
			</ol>
			<div className="mt-3 text-[11px]" style={{ color: BRAND_GREEN_TEXT }}>
				draft skipped — cache hit
			</div>
		</div>
	</div>
);
