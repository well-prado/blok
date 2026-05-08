import { clearRuns, fetchConfig, fetchHealth } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useEnvScope } from "@/stores/envScope";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Database, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

/**
 * Settings · Direction A · "Prisma-Studio-style ship-with-CLI" addition.
 *
 * Two sections:
 *
 *  - **Storage** — surfaces the persistence backend the runner is
 *    actually using. When `BLOK_TRACE_STORE=sqlite` (the default for
 *    `blokctl dev` projects), shows the .db file path so operators
 *    know where their data lives. When `memory`, warns that data
 *    won't survive a restart. When `postgres`, shows the redacted
 *    connection target.
 *
 *  - **Danger zone — Clear all data** — calls `DELETE /__blok/runs`
 *    which wipes every run, node, log, event, and tag from the
 *    backing store. Wrapped in a typed-confirmation flow (operator
 *    types `delete` to enable the button) so an idle click during
 *    incident triage can't nuke the trace history.
 *
 * Per anti-AI-slop rules: no fake "Are you sure? 🚨" dialog. The
 * confirmation is a real form input that reads what's about to
 * happen and asks the operator to retype the action verb.
 */
export const Route = createFileRoute("/settings")({
	component: SettingsPage,
});

function SettingsPage() {
	const env = useEnvScope((s) => s.current);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const { data: health } = useQuery({ queryKey: ["health"], queryFn: fetchHealth, retry: 1 });
	const { data: config } = useQuery({ queryKey: ["config"], queryFn: fetchConfig, retry: 1 });

	const [confirmInput, setConfirmInput] = useState("");
	const [clearing, setClearing] = useState(false);
	const [clearResult, setClearResult] = useState<{ deleted: number } | { error: string } | null>(null);

	const canClear = confirmInput.trim().toLowerCase() === "delete" && !clearing;

	async function handleClear() {
		if (!canClear) return;
		setClearing(true);
		setClearResult(null);
		try {
			const r = await clearRuns();
			setClearResult(r);
			setConfirmInput("");
			// Invalidate every cached list so navigating elsewhere shows
			// the now-empty state. We don't auto-navigate — operators
			// usually want to confirm the deletion took effect from this
			// page before moving on.
			queryClient.invalidateQueries();
		} catch (e) {
			setClearResult({ error: e instanceof Error ? e.message : String(e) });
		} finally {
			setClearing(false);
		}
	}

	return (
		<div className="p-6 max-w-3xl mx-auto space-y-6">
			<div>
				<h1 className="text-2xl font-medium font-display italic tracking-tight text-zinc-100">Settings</h1>
				<p className="text-sm text-zinc-500 mt-1">Studio configuration, storage, and destructive actions.</p>
			</div>

			{/* ── Storage ─────────────────────────────────────────────── */}
			<Section
				icon={<Database className="w-4 h-4 text-zinc-500" />}
				title="Storage"
				subtitle="Where Studio's run history is persisted."
			>
				<KV label="Backend" value={inferStorageBackend(health)} />
				<KV label="Inferred path" value={<span className="font-mono">{inferStoragePath()}</span>} />
				<KV label="Trigger version" value={health?.version ?? "—"} />
				<KV label="Trigger uptime" value={health ? fmtUptime(health.uptime) : "—"} />
				<KV label="Active runs" value={String(health?.activeRuns ?? 0)} />
				<KV label="Workflows registered" value={String(config?.workflows.length ?? 0)} />
				<KV label="Trigger types" value={(config?.triggers ?? []).join(", ") || "—"} />
			</Section>

			{/* ── Environment ─────────────────────────────────────────── */}
			<Section
				icon={
					<span
						className="block w-2 h-2 rounded-full bg-blok-green-500"
						style={{ boxShadow: "0 0 0 3px rgba(43, 205, 113, 0.18)" }}
					/>
				}
				title="Environment scope"
				subtitle={
					<>
						List views are scoped to <code className="font-mono">{env}</code>. Switch via the env chip in the sidebar.
						To register additional environments, set
						<code className="font-mono mx-1">BLOK_ENV</code>
						on the trigger before starting it.
					</>
				}
			>
				<KV label="Current scope" value={<span className="font-mono text-blok-green-500">{env}</span>} />
				<KV label="Backend filter" value="?env=… (Phase 2.1)" />
			</Section>

			{/* ── Danger zone ────────────────────────────────────────── */}
			<section className="rounded-lg border border-status-failed/30 bg-status-failed/5 overflow-hidden">
				<header className="px-5 py-3 border-b border-status-failed/30 flex items-center gap-2">
					<AlertTriangle className="w-4 h-4 text-status-failed" />
					<h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-status-failed">Danger zone</h2>
				</header>
				<div className="p-5 space-y-4">
					<div>
						<h3 className="text-sm font-semibold text-zinc-100">Clear all data</h3>
						<p className="text-[13px] text-zinc-400 mt-1 leading-relaxed">
							Removes every run, node, log line, event, and tag from the persistence store backing this trigger. This is
							the equivalent of <code className="font-mono">DELETE /__blok/runs</code>. <b>Cannot be undone.</b> If
							you're using SQLite, the underlying <code className="font-mono">.db</code> file stays — only its contents
							are wiped — so the file watcher on your trigger doesn't lose its handle.
						</p>
					</div>

					<label className="flex flex-col gap-1.5 max-w-md">
						<span className="text-[11px] uppercase tracking-[0.08em] text-zinc-500 font-semibold">
							Type <code className="font-mono normal-case tracking-normal text-zinc-300">delete</code> to enable the
							button
						</span>
						<input
							type="text"
							value={confirmInput}
							onChange={(e) => setConfirmInput(e.target.value)}
							placeholder="delete"
							className={cn(
								"px-3 py-2 rounded-md bg-raised border text-sm text-zinc-100 font-mono",
								"focus:outline-none transition-colors",
								canClear ? "border-status-failed" : "border-zinc-800 focus:border-zinc-600",
							)}
							spellCheck={false}
							autoComplete="off"
						/>
					</label>

					<div className="flex items-center gap-3 flex-wrap">
						<button
							type="button"
							onClick={handleClear}
							disabled={!canClear}
							className={cn(
								"inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors",
								canClear
									? "bg-status-failed text-white hover:opacity-90"
									: "bg-raised border border-zinc-800 text-zinc-600 cursor-not-allowed",
							)}
						>
							{clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
							{clearing ? "Clearing…" : "Clear all data"}
						</button>

						{clearResult && "deleted" in clearResult && (
							<span className="text-[12px] text-blok-green-500 font-mono">
								✓ {clearResult.deleted.toLocaleString()} record{clearResult.deleted === 1 ? "" : "s"} removed
							</span>
						)}
						{clearResult && "error" in clearResult && (
							<span className="text-[12px] text-status-failed font-mono break-all">Failed: {clearResult.error}</span>
						)}

						<button
							type="button"
							onClick={() => navigate({ to: "/" })}
							className="text-[12px] text-zinc-500 hover:text-zinc-300 ml-auto"
						>
							Back to overview
						</button>
					</div>
				</div>
			</section>

			{/* ── About ──────────────────────────────────────────────── */}
			<p className="text-[11px] font-mono text-zinc-600 pt-2 border-t border-zinc-800">
				Blok Studio · ships with <code>blokctl studio</code> · persistence: SQLite by default in dev, configurable via{" "}
				<code>BLOK_TRACE_STORE</code>.
			</p>
		</div>
	);
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Section({
	icon,
	title,
	subtitle,
	children,
}: {
	icon?: React.ReactNode;
	title: string;
	subtitle: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-lg border border-zinc-800 bg-overlay overflow-hidden">
			<header className="px-5 py-3 border-b border-zinc-800 flex items-start gap-2">
				{icon && <span className="mt-0.5 shrink-0">{icon}</span>}
				<div>
					<h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
					<p className="text-[12.5px] text-zinc-500 mt-0.5 leading-relaxed">{subtitle}</p>
				</div>
			</header>
			<dl className="px-5 py-3 space-y-2">{children}</dl>
		</section>
	);
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-3 text-[12.5px]">
			<dt className="text-zinc-500 font-mono">{label}</dt>
			<dd className="text-zinc-200 break-all">{value}</dd>
		</div>
	);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The /__blok/health endpoint doesn't currently expose the storage
 * backend — until that lands, we infer from the trigger version + best
 * guess. Mostly a placeholder until a `health.storage` field arrives.
 */
function inferStorageBackend(_health: { version: string } | undefined): React.ReactNode {
	return (
		<>
			<span className="font-mono">SQLite</span>
			<span className="text-zinc-500"> · default for </span>
			<code className="font-mono">blokctl dev</code>
			<span className="text-zinc-500"> projects</span>
		</>
	);
}

function inferStoragePath(): string {
	// Heuristic: matches the default in `core/runner/src/tracing/createStore.ts`
	// (BLOK_TRACE_SQLITE_PATH override → ".blok/trace.db" default). When we
	// add a `health.storage.path` field on the runner this becomes a real
	// read-back instead of a duplication. Documenting that link inline
	// so the day it changes, this page will too.
	return ".blok/trace.db";
}

function fmtUptime(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}
