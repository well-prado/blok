import { type RefDiagnosticsView, shortMessage, suggestedFields } from "@/lib/refDiagnostics";
import { cn } from "@/lib/utils";
import { AlertTriangle, CircleCheck, XCircle } from "lucide-react";

/**
 * #691 — the JSON twin's half of the shared ref diagnostics. Same
 * `validateRefs` result the canvas renders as per-node markers, listed here
 * against the document location (`steps[1].inputs.body.served`) so an author
 * reading the raw IR can jump straight to the offending value.
 *
 * The producer's declared field list doubles as the suggestion list — the same
 * catalog that answers "what CAN I reference?" in the upstream picker.
 */
export function RefDiagnosticsPanel({ diagnostics }: { diagnostics: RefDiagnosticsView }) {
	const { errors, warnings, uncheckedSteps } = diagnostics;

	if (errors.length === 0 && warnings.length === 0) {
		return (
			<div className="mb-3 flex items-center gap-2 rounded-md border border-zinc-800 bg-raised px-3 py-2 text-xs text-zinc-400">
				<CircleCheck className="h-3.5 w-3.5 text-blok-green-400" />
				<span>No step-output reference problems.</span>
				{uncheckedSteps.length > 0 && (
					<span className="text-zinc-500">
						{uncheckedSteps.length} step(s) unchecked — the node advertises no output schema.
					</span>
				)}
			</div>
		);
	}

	return (
		<div className="mb-3 space-y-1.5">
			{[...errors, ...warnings].map((d) => {
				const fields = suggestedFields(d);
				return (
					<div
						key={`${d.code}:${d.path}:${d.producer}:${d.refPath}`}
						className={cn(
							"rounded-md border px-3 py-2 text-xs",
							d.severity === "error"
								? "border-red-500/40 bg-red-500/5 text-red-200"
								: "border-amber-500/40 bg-amber-500/5 text-amber-200",
						)}
					>
						<div className="flex items-start gap-2">
							{d.severity === "error" ? (
								<XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							) : (
								<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							)}
							<div className="min-w-0">
								<div className="font-mono text-[11px] text-zinc-400">
									{d.path} <span className="text-zinc-600">[{d.code}]</span>
								</div>
								<div className="mt-0.5">{shortMessage(d)}</div>
								{fields.length > 0 && (
									<div className="mt-1 text-[11px] text-zinc-400">
										available on <span className="font-mono">{d.producer}</span>:{" "}
										<span className="font-mono text-zinc-300">{fields.join(", ")}</span>
									</div>
								)}
							</div>
						</div>
					</div>
				);
			})}
			{uncheckedSteps.length > 0 && (
				<div className="px-1 text-[11px] text-zinc-500">
					{uncheckedSteps.length} step(s) unchecked — the node advertises no output schema.
				</div>
			)}
		</div>
	);
}
