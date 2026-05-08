import { JsonViewer } from "@/components/shared/JsonViewer";
import { cn } from "@/lib/utils";
import type { NodeRunErrorDetail } from "@/types";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";

/**
 * Rich failure-detail card for a node `error` per master plan §17.10.
 *
 * Renders the typed-BlokError affordances (category pill, severity badge,
 * http status, retryable + retry_after, remediation callout, doc-url
 * link, causes drawer, context-snapshot tree) when those fields are
 * present. Falls back to the legacy two-line message+stack render for
 * unstructured throws so legacy nodes still surface.
 *
 * The component is a pure projection of {@link NodeRunErrorDetail} —
 * no data fetching, no mutation. Callers (e.g. `NodeDetail`) place it
 * inside whatever container styling they need.
 */
export function BlokErrorDetail({ error }: { error: NodeRunErrorDetail }) {
	const hasStructure =
		Boolean(error.category) ||
		Boolean(error.severity) ||
		typeof error.httpStatus === "number" ||
		typeof error.retryable === "boolean" ||
		Boolean(error.description) ||
		Boolean(error.remediation) ||
		Boolean(error.docUrl) ||
		(error.causes && error.causes.length > 0);

	return (
		<div className="rounded-md border border-red-900/50 bg-red-950/30 p-3 space-y-3">
			{/* Top row: severity + category + http status + retryable */}
			<div className="flex flex-wrap items-center gap-2">
				<SeverityBadge severity={error.severity} />
				<CategoryPill category={error.category} />
				{typeof error.httpStatus === "number" && (
					<span className="text-[10px] font-mono text-red-300/80 px-1.5 py-0.5 rounded bg-red-900/40 border border-red-900/50">
						HTTP {error.httpStatus}
					</span>
				)}
				{typeof error.retryable === "boolean" && error.retryable && (
					<span className="flex items-center gap-1 text-[10px] font-mono text-amber-300 px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-900/50">
						<RefreshCw className="w-2.5 h-2.5" />
						retryable
						{typeof error.retryAfterMs === "number" && error.retryAfterMs > 0 && (
							<span className="text-amber-400/70">· {formatRetryAfter(error.retryAfterMs)}</span>
						)}
					</span>
				)}
			</div>

			{/* Code (mono) */}
			{error.code && <div className="font-mono text-[11px] text-red-400/90 leading-tight">{error.code}</div>}

			{/* One-sentence summary */}
			<p className="text-xs text-red-200 font-mono break-all leading-snug">{error.message}</p>

			{/* Description (multi-paragraph context) */}
			{error.description && error.description !== error.message && (
				<p className="text-xs text-red-300/80 leading-relaxed whitespace-pre-wrap">{error.description}</p>
			)}

			{/* Remediation callout */}
			{error.remediation && (
				<div className="rounded border border-amber-900/40 bg-amber-950/30 p-2.5">
					<div className="flex items-start gap-2">
						<AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
						<div className="flex-1 min-w-0">
							<div className="text-[10px] font-medium uppercase tracking-wider text-amber-300/80 mb-0.5">
								Remediation
							</div>
							<p className="text-xs text-amber-100/90 leading-snug">{error.remediation}</p>
						</div>
					</div>
				</div>
			)}

			{/* Doc URL link */}
			{error.docUrl && (
				<a
					href={error.docUrl}
					target="_blank"
					rel="noreferrer noopener"
					className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 hover:underline"
				>
					<ExternalLink className="w-3 h-3" />
					Documentation
				</a>
			)}

			{/* Structured details (category-specific payload) */}
			{error.details !== undefined && error.details !== null && (
				<details className="text-xs">
					<summary className="cursor-pointer text-red-400/70 hover:text-red-300 select-none">Details</summary>
					<div className="mt-2 pl-2 border-l border-red-900/40">
						<JsonViewer data={error.details} defaultExpanded={false} />
					</div>
				</details>
			)}

			{/* Causes drawer */}
			{error.causes && error.causes.length > 0 && (
				<details className="text-xs">
					<summary className="cursor-pointer text-red-400/70 hover:text-red-300 select-none">
						Causes ({error.causes.length})
					</summary>
					<div className="mt-2 space-y-2 pl-2 border-l border-red-900/40">
						{error.causes.map((cause, idx) => (
							<CauseLink key={`${cause.code ?? "uncoded"}-${idx}`} cause={cause} />
						))}
					</div>
				</details>
			)}

			{/* Context snapshot (bounded inputs+vars at error time) */}
			{error.contextSnapshot !== undefined && error.contextSnapshot !== null && (
				<details className="text-xs">
					<summary className="cursor-pointer text-red-400/70 hover:text-red-300 select-none">Context snapshot</summary>
					<div className="mt-2 pl-2 border-l border-red-900/40">
						<JsonViewer data={error.contextSnapshot} defaultExpanded={false} />
					</div>
				</details>
			)}

			{/* Stack trace */}
			{error.stack && (
				<details className="text-xs">
					<summary className="cursor-pointer text-red-400/70 hover:text-red-300 select-none">Stack trace</summary>
					<pre className="mt-2 text-[10px] text-red-400/60 overflow-x-auto whitespace-pre-wrap break-all max-h-48 pl-2 border-l border-red-900/40">
						{error.stack}
					</pre>
				</details>
			)}

			{/* Tag the legacy form for clarity when no structure surfaces */}
			{!hasStructure && (
				<p className="text-[10px] text-red-500/50 italic">
					Untyped error — node author can adopt `BlokError` for richer detail.
				</p>
			)}
		</div>
	);
}

/**
 * 4-state severity badge. `INFO` is yellow-tinged (normally we wouldn't
 * even render a card for INFO, but the proto allows it); `ERROR` is the
 * default red; `FATAL` adds a glow ring; `WARN` is amber.
 */
function SeverityBadge({ severity }: { severity?: string }) {
	if (!severity) return null;
	const styles: Record<string, string> = {
		INFO: "bg-blue-950/60 border-blue-900/60 text-blue-300",
		WARN: "bg-amber-950/60 border-amber-900/60 text-amber-200",
		ERROR: "bg-red-950/60 border-red-900/60 text-red-200",
		FATAL: "bg-red-950/80 border-red-700/70 text-red-100 ring-1 ring-red-700/40",
	};
	return (
		<span
			className={cn(
				"text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border",
				styles[severity] ?? styles.ERROR,
			)}
		>
			{severity}
		</span>
	);
}

/**
 * Category pill — the visual hook for category-based filtering. Color
 * mapping mirrors the docs/error-codes.md table conceptually:
 * dependency/timeout/rate-limit are warm (retryable), validation/data are
 * blue (input issues), permission/conflict are violet (auth/concurrency),
 * internal/protocol are slate (uncategorized fallthrough).
 */
function CategoryPill({ category }: { category?: string }) {
	if (!category) return null;
	const styles: Record<string, string> = {
		VALIDATION: "bg-blue-950/60 border-blue-900/60 text-blue-200",
		CONFIGURATION: "bg-zinc-900 border-zinc-700 text-zinc-300",
		DEPENDENCY: "bg-orange-950/60 border-orange-900/60 text-orange-200",
		TIMEOUT: "bg-amber-950/60 border-amber-900/60 text-amber-200",
		PERMISSION: "bg-violet-950/60 border-violet-900/60 text-violet-200",
		RATE_LIMIT: "bg-rose-950/60 border-rose-900/60 text-rose-200",
		NOT_FOUND: "bg-sky-950/60 border-sky-900/60 text-sky-200",
		CONFLICT: "bg-purple-950/60 border-purple-900/60 text-purple-200",
		CANCELLED: "bg-zinc-900 border-zinc-700 text-zinc-400",
		INTERNAL: "bg-red-950/60 border-red-900/60 text-red-200",
		PROTOCOL: "bg-fuchsia-950/60 border-fuchsia-900/60 text-fuchsia-200",
		DATA: "bg-cyan-950/60 border-cyan-900/60 text-cyan-200",
	};
	return (
		<span
			className={cn(
				"text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border",
				styles[category] ?? styles.INTERNAL,
			)}
		>
			{category}
		</span>
	);
}

/**
 * One row in the causes drawer — one cause-chain entry. Each cause is
 * itself a `NodeError` payload (snake_case keys, since it comes off the
 * wire), so we read both wire and friendly key spellings.
 */
function CauseLink({ cause }: { cause: Record<string, unknown> }) {
	const code = (cause.code as string | undefined) ?? "uncoded";
	const message = (cause.message as string | undefined) ?? "";
	const category = cause.category as string | undefined;
	return (
		<div className="rounded border border-red-900/30 bg-red-950/20 p-2 space-y-1">
			<div className="flex items-center gap-2">
				<CategoryPill category={category} />
				<span className="font-mono text-[10px] text-red-400/80 truncate">{code}</span>
			</div>
			{message && <p className="text-[11px] text-red-300/80 break-all">{message}</p>}
		</div>
	);
}

/**
 * Format `retry_after_ms` into a compact human-readable hint:
 * `5_000` → `"5s"`, `60_000` → `"60s"`, `1_500_000` → `"25m"`. Avoids
 * `1.5s`-style decimals to keep the badge tight.
 */
function formatRetryAfter(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}m`;
}
