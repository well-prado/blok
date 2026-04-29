import { JsonViewer } from "@/components/shared/JsonViewer";
import { ExplainError } from "@/components/trace/ExplainError";
import { cn } from "@/lib/utils";
import type { NodeRunErrorDetail } from "@/types";
import { ArrowUpRight, RefreshCw } from "lucide-react";

/**
 * BlokErrorFrame — Direction A's signature reframe. When a step has an
 * error, the error becomes the *page topic* in the center pane: a wide
 * banner of pills + a monospace headline + a blame paragraph, followed
 * by a remediation callout, a causes table, and a context-snapshot
 * grid. The intent is opposite of `BlokErrorDetail` (which is a tight
 * card meant for sidebars / drawers / per-cause details). When you're
 * here, the error *is* the thing — it deserves the page.
 *
 * Reads everything from the typed-BlokError payload; falls back to the
 * legacy {message, stack} shape gracefully so untyped errors still
 * surface, just without the affordances.
 *
 * Visual contract (the 120% piece this turn):
 *   - Top banner uses red-tinted `bg-red-950/30` with a subtle red border
 *     to immediately mark the page topic without competing with the
 *     status palette elsewhere (running blue / completed brand-green).
 *   - Three pills (category · severity · retryable) carry color metadata.
 *     Categories follow the same color map as `BlokErrorDetail` so users
 *     who learn one place learn both.
 *   - Headline is mono, color-tokenized: class name in amber, host in
 *     brand-green (operators reading "127.0.0.1:10004" want the host to
 *     pop), the rest in dim ink-2.
 *   - Remediation callout is brand-green left-bar — the *only* spot in
 *     the error frame that uses brand color, so it reads as "the way out"
 *     rather than another red row.
 */
type Props = {
	error: NodeRunErrorDetail;
	stepName: string;
	stepIndex: number;
	totalSteps: number;
	runtimeKind?: string;
	transport?: string;
	finishedAt?: number;
	runId: string;
	nodeId: string;
};

export function BlokErrorFrame({
	error,
	stepName,
	stepIndex,
	totalSteps,
	runtimeKind,
	transport,
	finishedAt,
	runId,
	nodeId,
}: Props) {
	const hasStructure =
		Boolean(error.category) ||
		Boolean(error.severity) ||
		typeof error.retryable === "boolean" ||
		Boolean(error.remediation) ||
		Boolean(error.docUrl) ||
		(error.causes && error.causes.length > 0);

	return (
		<div className="flex flex-col">
			{/* ── BIG ERROR BANNER · the page topic ─────────────────────── */}
			<section className="bg-red-950/30 border-b border-red-900/50 px-8 py-6">
				{/* Pills row */}
				<div className="flex flex-wrap items-center gap-2 mb-4 font-mono text-[11px]">
					<CategoryPill category={error.category} />
					<SeverityPill severity={error.severity} />
					{typeof error.retryable === "boolean" && error.retryable && (
						<span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-semibold uppercase tracking-[0.06em] text-[10px] bg-blue-500/15 text-blue-400 border border-blue-500/30">
							<RefreshCw className="w-2.5 h-2.5" />
							retryable
							{typeof error.retryAfterMs === "number" && error.retryAfterMs > 0 && (
								<span className="opacity-70">· {formatRetryAfter(error.retryAfterMs)}</span>
							)}
						</span>
					)}
					<span className="ml-auto text-zinc-500 truncate">
						step <span className="text-zinc-200 font-medium">{stepName}</span>
						{runtimeKind && <span className="text-zinc-600"> · {runtimeKind}</span>}
						{transport && <span className="text-zinc-600"> · {transport}</span>}
						{finishedAt && <span className="text-zinc-600"> · {new Date(finishedAt).toISOString().slice(11, 19)}</span>}
					</span>
				</div>

				{/* Headline — mono, color-tokenized */}
				<h2 className="font-mono text-lg leading-snug font-medium text-zinc-100 mb-3 break-words">
					<HeadlineMessage code={error.code} message={error.message} />
				</h2>

				{/* Blame paragraph — only when there's structure to summarize */}
				{(error.description || hasStructure) && (
					<p className="text-[13px] text-zinc-300 leading-relaxed font-mono whitespace-pre-wrap max-w-3xl">
						{error.description ?? defaultBlame(error)}
					</p>
				)}
			</section>

			{/* ── BODY ──────────────────────────────────────────────────── */}
			<section className="px-8 py-6 space-y-6">
				{/* Remediation — brand-green left bar (the way out) */}
				{error.remediation && (
					<div>
						<H3>Remediation</H3>
						<div className="rounded-r-md border-l-[3px] border-blok-green-500 bg-overlay px-4 py-3">
							<p className="text-[13px] text-zinc-100 leading-relaxed whitespace-pre-wrap">{error.remediation}</p>
							{error.docUrl && (
								<a
									href={error.docUrl}
									target="_blank"
									rel="noreferrer noopener"
									className="inline-flex items-center gap-1.5 mt-2.5 font-mono text-[12px] text-blok-green-500 hover:text-blok-green-600 hover:underline font-medium"
								>
									<ArrowUpRight className="w-3.5 h-3.5" />
									{shortenDocUrl(error.docUrl)}
								</a>
							)}
						</div>
					</div>
				)}

				{/* AI explain offer — small, separate from typed data */}
				<div>
					<H3>AI explain</H3>
					<div className="rounded-md bg-overlay border border-zinc-800 px-4 py-3">
						<ExplainError runId={runId} nodeId={nodeId} compact />
					</div>
				</div>

				{/* Category-specific structured details — gRPC adapter writes
				    `{ grpcStatus, grpcMessage }`, validation writes the failed
				    field path, etc. We render flat top-level keys as a tight
				    label/value pair grid; nested values get a JsonViewer
				    fallback. Skipping the section entirely when `details` is
				    undefined — better than showing an empty frame. */}
				{error.details !== undefined && error.details !== null && (
					<div>
						<H3>Details</H3>
						<ContextGrid snapshot={error.details} />
					</div>
				)}

				{/* Causes — table view */}
				{error.causes && error.causes.length > 0 && (
					<div>
						<H3>
							Causes{" "}
							<span className="text-zinc-600 font-normal normal-case tracking-normal">· {error.causes.length}</span>
						</H3>
						<div className="rounded-md border border-zinc-800 bg-overlay overflow-hidden">
							<div className="grid grid-cols-[100px_1fr_auto] gap-3 px-4 py-2 text-[10px] uppercase tracking-[0.06em] text-zinc-500 border-b border-zinc-800 bg-canvas/40 font-semibold">
								<span>category</span>
								<span>code · message</span>
								<span>idx</span>
							</div>
							{error.causes.map((cause, idx) => {
								const code = (cause.code as string | undefined) ?? "uncoded";
								const message = (cause.message as string | undefined) ?? "";
								const category = cause.category as string | undefined;
								// Stable key: code + first 32 chars of message (causes
								// can repeat the same code with different messages, e.g.
								// "TIMEOUT" appearing at multiple retry attempts). Falls
								// back to "uncoded-N" only when both fields are empty.
								const k = code === "uncoded" && !message ? `uncoded-${idx}` : `${code}::${message.slice(0, 32)}`;
								return (
									<div
										key={k}
										className="grid grid-cols-[100px_1fr_auto] gap-3 px-4 py-2.5 border-b border-zinc-800 last:border-b-0 font-mono text-[12px] items-baseline"
									>
										<span className="text-[10px]">
											<CategoryPill category={category} compact />
										</span>
										<div className="min-w-0">
											<div className="text-zinc-100 truncate">{code}</div>
											{message && <div className="text-zinc-400 text-[11.5px] mt-0.5 break-words">{message}</div>}
										</div>
										<span className="text-zinc-600 text-[11px]">#{idx + 1}</span>
									</div>
								);
							})}
						</div>
					</div>
				)}

				{/* Context snapshot — 2-col mono grid */}
				{error.contextSnapshot !== undefined && error.contextSnapshot !== null && (
					<div>
						<H3>Context snapshot</H3>
						<ContextGrid snapshot={error.contextSnapshot} />
					</div>
				)}

				{/* Stack — collapsed by default; raw escape hatch */}
				{error.stack && (
					<details>
						<summary className="cursor-pointer text-[11px] uppercase tracking-[0.08em] text-zinc-500 font-semibold hover:text-zinc-300 select-none mb-2">
							Stack trace
						</summary>
						<pre className="rounded-md border border-zinc-800 bg-overlay px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
							{error.stack}
						</pre>
					</details>
				)}

				{/* Tag legacy untyped throws so node authors know to upgrade */}
				{!hasStructure && (
					<p className="text-[11px] text-zinc-500 italic">
						Untyped error — adopt `BlokError` to surface category, remediation, and causes here.
					</p>
				)}

				{/* Bottom: step position breadcrumb */}
				<p className="text-[11px] font-mono text-zinc-600 pt-2 border-t border-zinc-800">
					Failed at step <span className="text-zinc-300">{stepIndex + 1}</span> of {totalSteps}.{" "}
					<span className="text-zinc-500">Subsequent steps were skipped.</span>
				</p>
			</section>
		</div>
	);
}

// ── Sub-components ─────────────────────────────────────────────────────────

function H3({ children }: { children: React.ReactNode }) {
	return <h3 className="text-[11px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mb-2">{children}</h3>;
}

function HeadlineMessage({ code, message }: { code?: string; message: string }) {
	// Try to highlight a `host:port` token — operators benefit from it
	// popping in green so the eye lands on "where" before "what".
	const hostPortRegex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+|localhost:\d+)\b/;
	const match = message.match(hostPortRegex);
	const before = match ? message.slice(0, match.index) : message;
	const host = match ? match[0] : "";
	const after = match ? message.slice((match.index ?? 0) + host.length) : "";
	return (
		<>
			{code && <span className="text-amber-400/95">{code}</span>}
			{code && <span className="text-zinc-500">: </span>}
			<span className="text-zinc-300">{before}</span>
			{host && <span className="text-blok-green-500">{host}</span>}
			<span className="text-zinc-300">{after}</span>
		</>
	);
}

function defaultBlame(error: NodeRunErrorDetail): string {
	const cat = error.category;
	if (cat === "DEPENDENCY") {
		return "An upstream service the step depends on is unavailable. The runner will retry per the policy below; if retries exhaust the breaker opens for 30 s.";
	}
	if (cat === "TIMEOUT") {
		return "The step exceeded its allowed runtime. This is usually a downstream slowness signal, not a bug in the node itself.";
	}
	if (cat === "VALIDATION") {
		return "The step's input failed schema validation. Inputs are checked against the node's Zod schema before `execute()` is called.";
	}
	if (cat === "RATE_LIMIT") {
		return "The step was rate-limited by a downstream service. Backoff is applied per the retry-after hint below.";
	}
	return "The step did not complete. Inspect the cause chain and context snapshot below for the operative state at the moment of failure.";
}

function shortenDocUrl(url: string): string {
	try {
		const u = new URL(url);
		return `${u.host}${u.pathname}`.replace(/\/+$/, "");
	} catch {
		return url;
	}
}

function formatRetryAfter(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}m`;
}

function ContextGrid({ snapshot }: { snapshot: unknown }) {
	// Top-level keys → 2-col label/value grid. For nested values fall back
	// to the JSON tree (collapsed by default) under a "details" disclosure.
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		return (
			<div className="rounded-md border border-zinc-800 bg-overlay px-4 py-3">
				<JsonViewer data={snapshot} defaultExpanded={false} />
			</div>
		);
	}
	const entries = Object.entries(snapshot as Record<string, unknown>);
	const flat = entries.filter(([, v]) => v == null || typeof v !== "object");
	const nested = entries.filter(([, v]) => v != null && typeof v === "object");
	return (
		<div className="rounded-md border border-zinc-800 bg-overlay overflow-hidden">
			<div className="grid grid-cols-2">
				{flat.map(([k, v], idx) => (
					<div
						key={k}
						className={cn(
							"px-4 py-2.5 font-mono text-[11.5px]",
							"border-zinc-800",
							idx % 2 === 0 ? "border-r" : "",
							idx < flat.length - 2 ? "border-b" : "",
							flat.length % 2 === 1 && idx === flat.length - 1 ? "col-span-2" : "",
						)}
					>
						<div className="text-[10px] uppercase tracking-[0.06em] text-zinc-500 mb-1">{k}</div>
						<div className="text-zinc-100 break-all">{formatScalar(v)}</div>
					</div>
				))}
			</div>
			{nested.length > 0 && (
				<details className="border-t border-zinc-800 px-4 py-2">
					<summary className="cursor-pointer text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold hover:text-zinc-300 select-none">
						nested ({nested.length})
					</summary>
					<div className="mt-2">
						<JsonViewer data={Object.fromEntries(nested)} defaultExpanded={false} />
					</div>
				</details>
			)}
		</div>
	);
}

function formatScalar(v: unknown): string {
	if (v == null) return "—";
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	if (typeof v === "boolean") return v ? "true" : "false";
	return JSON.stringify(v);
}

// ── Pills ──────────────────────────────────────────────────────────────────

function CategoryPill({ category, compact }: { category?: string; compact?: boolean }) {
	if (!category) return null;
	const styles: Record<string, string> = {
		VALIDATION: "bg-blue-500/15 text-blue-300 border-blue-500/30",
		CONFIGURATION: "bg-zinc-700/40 text-zinc-300 border-zinc-600/40",
		DEPENDENCY: "bg-orange-500/15 text-orange-300 border-orange-500/30",
		TIMEOUT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
		PERMISSION: "bg-violet-500/15 text-violet-300 border-violet-500/30",
		RATE_LIMIT: "bg-rose-500/15 text-rose-300 border-rose-500/30",
		NOT_FOUND: "bg-sky-500/15 text-sky-300 border-sky-500/30",
		CONFLICT: "bg-purple-500/15 text-purple-300 border-purple-500/30",
		CANCELLED: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40",
		INTERNAL: "bg-red-500/15 text-red-300 border-red-500/30",
		PROTOCOL: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
		DATA: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
	};
	const cls = styles[category] ?? styles.INTERNAL;
	return (
		<span
			className={cn(
				"font-mono uppercase tracking-[0.06em] font-semibold rounded-full border",
				compact ? "text-[10px] px-2 py-0.5" : "text-[10px] px-2.5 py-0.5",
				cls,
			)}
		>
			{category}
		</span>
	);
}

function SeverityPill({ severity }: { severity?: string }) {
	if (!severity) return null;
	const styles: Record<string, string> = {
		INFO: "bg-blue-500/15 text-blue-300 border-blue-500/30",
		WARN: "bg-amber-500/15 text-amber-300 border-amber-500/30",
		ERROR: "bg-red-500/15 text-red-300 border-red-500/30",
		FATAL: "bg-red-500/25 text-red-200 border-red-500/40 ring-1 ring-red-500/40",
	};
	return (
		<span
			className={cn(
				"font-mono text-[10px] uppercase tracking-[0.06em] font-semibold rounded-full border px-2.5 py-0.5",
				styles[severity] ?? styles.ERROR,
			)}
		>
			{severity}
		</span>
	);
}
