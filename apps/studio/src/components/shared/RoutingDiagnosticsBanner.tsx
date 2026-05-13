import { useRoutingDiagnostics } from "@/hooks/useRoutingDiagnostics";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";

/**
 * Banner shown when the HTTP trigger reported boot-time route-build
 * problems (collisions, missing paths). Surfaces what the terminal
 * would have logged — operators shouldn't have to read trigger output
 * to know why a workflow is missing or rejected.
 *
 * Stays out of the way when there's nothing to report (returns `null`).
 * Click the chevron to expand the full list. Insertion-order is
 * preserved so the FIRST collision (often the upstream cause of others)
 * sorts to the top.
 */
export function RoutingDiagnosticsBanner() {
	const { data } = useRoutingDiagnostics();
	const [expanded, setExpanded] = useState(false);

	if (!data || data.count === 0) return null;

	return (
		<div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex items-start gap-3 w-full text-left"
				aria-expanded={expanded}
			>
				<AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
				<div className="flex-1">
					<div className="text-sm font-medium text-amber-200">
						{data.count} workflow{data.count === 1 ? "" : "s"} dropped due to routing problems
					</div>
					<div className="text-xs text-amber-400/80 mt-0.5">
						{expanded ? "Click to collapse" : "Click to see which workflows + why"}
					</div>
				</div>
			</button>

			{expanded && (
				<ul className="mt-3 space-y-2 border-t border-amber-500/20 pt-3">
					{data.diagnostics.map((d) => (
						<li
							key={`${d.kind}-${d.method ?? ""}-${d.path ?? ""}-${d.droppedSource ?? ""}-${d.recordedAt}`}
							className="text-xs text-amber-100/90 font-mono whitespace-pre-wrap leading-relaxed"
						>
							<div className="text-amber-300 font-semibold">
								{d.method && d.path ? `${d.method} ${d.path}` : d.kind}
							</div>
							<div className="text-amber-200/80">{d.message}</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
