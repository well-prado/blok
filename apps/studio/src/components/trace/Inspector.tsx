import { cn } from "@/lib/utils";
import type { NodeRun, TraceLogEntry } from "@/types";

/**
 * Right-pane inspector — Direction A's "what does the operator see when
 * they're staring at one step at 50cm during an incident". Dense metrics
 * grid + live log tail just for the active step + keyboard cheat-sheet
 * footer. Stays mounted regardless of which center-pane mode is active so
 * the spatial frame is stable.
 *
 * Wire-byte cells (`request_bytes` / `response_bytes`) appear only when
 * the runner persisted them — gRPC adapter populates them; HTTP adapter
 * doesn't, so module/HTTP nodes show "—" for those cells without
 * cluttering the layout. The Phase 0 metrics fix that landed in
 * RuntimeAdapterNode + RunnerSteps + completeNode is what makes these
 * fields actually reach this component.
 */
type Props = {
	node: NodeRun | null;
	logs: TraceLogEntry[];
};

function fmtBytes(n: number | undefined): string {
	if (n == null) return "—";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMs(n: number | undefined): string {
	if (n == null) return "—";
	if (n < 1) return `${n.toFixed(2)} ms`;
	if (n < 1000) return `${n.toFixed(1)} ms`;
	return `${(n / 1000).toFixed(2)} s`;
}

export function Inspector({ node, logs }: Props) {
	if (!node) {
		return (
			<aside className="h-full bg-overlay border-l border-zinc-800 p-5 flex flex-col">
				<h4 className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mb-3">Inspector</h4>
				<p className="text-xs text-zinc-500 leading-relaxed">
					Select a step from the rail to see its metrics, wire bytes, and live log tail.
				</p>
				<KeyboardFooter />
			</aside>
		);
	}

	const m = node.metrics ?? {};
	const nodeLogs = logs.filter((l) => l.nodeId === node.id || l.nodeName === node.nodeName);

	return (
		<aside className="h-full bg-overlay border-l border-zinc-800 p-5 overflow-y-auto flex flex-col">
			{/* Metrics grid — 2 cols × 3 rows, dense numbers in mono */}
			<h4 className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mb-2">Metrics</h4>
			<div className="grid grid-cols-2 border border-zinc-800 rounded-lg overflow-hidden mb-5">
				<MetricCell label="Wall" value={fmtMs(node.durationMs)} />
				<MetricCell
					label="Wire"
					value={
						m.request_bytes != null || m.response_bytes != null
							? `${fmtBytes(m.request_bytes)} → ${fmtBytes(m.response_bytes)}`
							: "—"
					}
					dim={m.request_bytes == null && m.response_bytes == null}
				/>
				<MetricCell label="CPU" value={fmtMs(m.cpu_ms)} dim={!m.cpu_ms} />
				<MetricCell label="Memory" value={fmtBytes(m.memory_bytes)} dim={!m.memory_bytes} />
				<MetricCell label="Depth" value={String(node.depth)} />
				<MetricCell label="Step" value={`${node.stepIndex + 1}`} />
			</div>

			{/* Live tail — just this step's logs */}
			<h4 className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mb-2">
				Live tail · this step
			</h4>
			<div className="bg-canvas border border-zinc-800 rounded-lg flex-1 min-h-0 flex flex-col overflow-hidden">
				<div className="px-3 py-1.5 border-b border-zinc-800 text-[11px] text-zinc-400 flex items-center gap-2 font-mono">
					<span className="w-1.5 h-1.5 rounded-full bg-blok-green-500 animate-pulse-dot" />
					tailing
					<span className="ml-auto text-zinc-600">SSE</span>
				</div>
				<div className="overflow-y-auto flex-1 px-3 py-2 font-mono text-[11px] leading-snug">
					{nodeLogs.length === 0 ? (
						<p className="text-zinc-600 text-[11px]">no logs from this step yet</p>
					) : (
						nodeLogs.slice(-30).map((l) => (
							<div key={l.id} className="text-zinc-300 py-0.5">
								<span className="text-zinc-600 mr-2">{new Date(l.timestamp).toISOString().slice(11, 23)}</span>
								<span
									className={cn(
										"inline-block w-9 mr-1 text-[9px] uppercase tracking-[0.04em] font-semibold",
										l.level === "info" && "text-log-info",
										l.level === "warn" && "text-log-warn",
										l.level === "error" && "text-log-error",
										l.level === "debug" && "text-log-debug",
									)}
								>
									{l.level}
								</span>
								<span className="text-zinc-200">{l.message}</span>
							</div>
						))
					)}
				</div>
			</div>

			<KeyboardFooter />
		</aside>
	);
}

function MetricCell({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
	return (
		<div className="p-3 border-r border-b border-zinc-800 last-of-type:border-r-0 [&:nth-child(2n)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
			<div className="text-[10px] uppercase tracking-[0.06em] text-zinc-500 mb-1">{label}</div>
			<div className={cn("font-mono text-sm font-medium", dim ? "text-zinc-600" : "text-zinc-100")}>{value}</div>
		</div>
	);
}

function KeyboardFooter() {
	return (
		<div className="mt-5 pt-3 border-t border-zinc-800 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-zinc-600">
			<span className="inline-flex items-center gap-1">
				<Kbd>j</Kbd>
				<Kbd>k</Kbd> step
			</span>
			<span className="inline-flex items-center gap-1">
				<Kbd>1-5</Kbd> mode
			</span>
			<span className="inline-flex items-center gap-1">
				<Kbd>Esc</Kbd> deselect
			</span>
		</div>
	);
}

function Kbd({ children }: { children: React.ReactNode }) {
	return (
		<kbd className="font-mono text-[9px] px-1 py-px rounded bg-raised border border-zinc-800 text-zinc-400">
			{children}
		</kbd>
	);
}
