/**
 * Phase 5.3 — tryCatch structural editor. Unlike branch/forEach/switch,
 * `V2TryCatchStepSchema` (core/workflow-helper/src/types/StepOpts.ts:887-920)
 * exposes NOTHING scalar to edit: `{ id, tryCatch: { try, catch, finally? },
 * active?, stop?, ui? }`. There is no configurable error-variable name — the
 * caught error always lands on the fixed `$.error` / `ctx.error` (message,
 * name, stack, code, stepId — see TryCatchNode.toErrorEnvelope, documented in
 * core/runner/CLAUDE.md). So this is an informative panel, not a form: arm
 * step counts + the try/catch/finally semantics. The arms themselves (which
 * steps live in try/catch/finally) are edited on the canvas, not here.
 */

export interface RawTryCatch {
	try?: unknown;
	catch?: unknown;
	finally?: unknown;
	[key: string]: unknown;
}

export interface TryCatchEditorProps {
	stepId: string;
	tryCatch: RawTryCatch;
	onClose: () => void;
}

function armCount(arm: unknown): number {
	return Array.isArray(arm) ? arm.length : 0;
}

export function TryCatchEditor({ stepId, tryCatch, onClose }: TryCatchEditorProps) {
	const tryN = armCount(tryCatch.try);
	const catchN = armCount(tryCatch.catch);
	const finallyN = armCount(tryCatch.finally);

	return (
		<div
			aria-label={`tryCatch for ${stepId}`}
			className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950/70 px-3 py-2"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-zinc-300">
					tryCatch <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="button"
					onClick={onClose}
					className="ml-auto rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					Close
				</button>
			</div>

			<p className="mt-2 text-[10px] text-zinc-500">
				try: {tryN} step{tryN === 1 ? "" : "s"} · catch: {catchN} step{catchN === 1 ? "" : "s"} · finally: {finallyN}{" "}
				step{finallyN === 1 ? "" : "s"}
				{finallyN === 0 && " (not configured)"}
			</p>

			<div className="mt-3 flex flex-col gap-2 text-[11px] text-zinc-400">
				<p>
					tryCatch has no editable configuration beyond its three arms — there's no error-variable name to set; the
					caught error always lands on <span className="font-mono text-zinc-300">$.error</span> /{" "}
					<span className="font-mono text-zinc-300">ctx.error</span>. Add or remove steps inside each arm directly on
					the canvas.
				</p>
				<ul className="flex flex-col gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
					<li>
						<span className="font-mono text-zinc-300">try</span> runs first.
					</li>
					<li>
						On error, <span className="font-mono text-zinc-300">catch</span> runs with{" "}
						<span className="font-mono text-zinc-300">$.error</span> populated (message, name, stack, code, stepId).
						Errors thrown inside <span className="font-mono text-zinc-300">catch</span> propagate to the next outer
						handler — they do NOT re-trigger catch.
					</li>
					<li>
						<span className="font-mono text-zinc-300">finally</span> (if configured) always runs afterward — on normal
						completion, after a caught error, and after an uncaught error from inside catch. Errors from finally
						propagate.
					</li>
				</ul>
			</div>
		</div>
	);
}
