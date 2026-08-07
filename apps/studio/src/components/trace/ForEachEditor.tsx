import { UpstreamPicker } from "@/components/trace/UpstreamPicker";
import { walkSteps } from "@/lib/irEditOps";
import type { UpstreamSource } from "@/lib/upstreamSources";
import { Loader2, SquareFunction } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Phase 5.3 — forEach structural editor: `in` / `as` fields, lowered
 * straight onto the step's `forEach` config. Mirrors `BranchEditor`'s
 * shape, with one load-bearing difference: `forEach.in` resolves through
 * the SAME blueprint mapper regular step `inputs` use (`js/...` prefix —
 * core/runner/src/Configuration.ts:279-284, core/shared/src/NodeBase.ts's
 * `blueprintMapper`), NOT raw `ctx.*` JS like branch `when` (ADR 0004). So
 * unlike `BranchEditor`, the `UpstreamPicker` here is used WITHOUT `raw` —
 * a picked expression keeps its `js/` prefix.
 *
 * Verified IR shape (core/workflow-helper/src/types/StepOpts.ts:703-742,
 * confirmed live by irEditOps.test.ts:709 and the real
 * triggers/http/workflows/json/v05-nested-control-flow.json fixture):
 * `{ id, forEach: { in, as, mode?, concurrency?, do: Step[] } }`. Note
 * there is NO `asIndex` field — `as` is REQUIRED (WorkflowNormalizer.ts:710-716
 * throws "missing `as`" at load time if absent), and the per-iteration index
 * is auto-derived at runtime as `${as}Index` (ForEachNode.ts:98). `mode`/
 * `concurrency` are untouched extra fields this editor doesn't expose UI
 * for — preserved via the save-time spread, same as `do`.
 */

export interface RawForEach {
	in?: unknown;
	as?: unknown;
	do?: unknown;
	[key: string]: unknown;
}

export interface ForEachEditorProps {
	stepId: string;
	forEach: RawForEach;
	/** Upstream handle/value picker sources — computed by the caller via `upstreamSources()`. */
	sources: UpstreamSource[];
	/** Whole-workflow raw definition — walked for the as/asIndex namespace-collision warning. */
	definition: unknown;
	pending: boolean;
	error?: string;
	onSave: (forEach: RawForEach) => void;
	onClose: () => void;
}

function armCount(arm: unknown): number {
	return Array.isArray(arm) ? arm.length : 0;
}

/** Every `step.id` anywhere in the tree — mirrors irEditOps.ts's private `collectIds`. */
function collectStepIds(definition: unknown): Set<string> {
	const ids = new Set<string>();
	walkSteps(definition, (step) => {
		if (typeof step.id === "string") ids.add(step.id);
	});
	return ids;
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function ForEachEditor({
	stepId,
	forEach,
	sources,
	definition,
	pending,
	error,
	onSave,
	onClose,
}: ForEachEditorProps) {
	const [inText, setInText] = useState(typeof forEach.in === "string" ? forEach.in : "");
	const [asText, setAsText] = useState(typeof forEach.as === "string" ? forEach.as : "");
	const [picker, setPicker] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const stepIds = useMemo(() => collectStepIds(definition), [definition]);
	// The footgun: forEach's `as`/`as+"Index"` write into the SAME ctx.state
	// namespace as step ids (WorkflowNormalizer.ts:1250-1269 throws on this at
	// load time) — silently shadowing whichever step already owns that key.
	const collision =
		asText.trim() !== "" && (stepIds.has(asText.trim()) || stepIds.has(`${asText.trim()}Index`)) ? asText.trim() : null;

	const submit = () => {
		if (inText.trim() === "") {
			setFormError('"in" is required — the array to iterate.');
			return;
		}
		const as = asText.trim();
		if (as === "") {
			setFormError('"as" is required — the per-iteration variable name.');
			return;
		}
		if (!IDENTIFIER_RE.test(as)) {
			setFormError('"as" must be a valid identifier (letters, digits, underscore).');
			return;
		}
		setFormError(null);
		onSave({ ...forEach, in: inText, as });
	};

	const pick = (expr: string) => {
		setInText(expr);
		setPicker(false);
	};

	return (
		<form
			aria-label={`forEach for ${stepId}`}
			className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950/70 px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-zinc-300">
					forEach <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save forEach
				</button>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					Cancel
				</button>
			</div>

			<p className="mt-2 text-[10px] text-zinc-500">
				do: {armCount(forEach.do)} step{armCount(forEach.do) === 1 ? "" : "s"}
			</p>

			{error && <p className="mt-2 text-xs text-red-300">{error}</p>}
			{formError && <p className="mt-2 text-xs text-red-300">{formError}</p>}

			<div className="mt-2 flex flex-col gap-2 text-xs">
				<label className="flex flex-col gap-1">
					<span className="text-[10px] font-medium text-zinc-400">in (array to iterate)</span>
					<div className="relative flex w-full min-w-0 items-center gap-1">
						<input
							aria-label="in"
							value={inText}
							onChange={(event) => setInText(event.target.value)}
							placeholder="js/ctx.state.step.items"
							spellCheck={false}
							className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						/>
						<button
							type="button"
							title="Insert a value from an upstream step"
							onClick={() => setPicker((current) => !current)}
							className="shrink-0 text-zinc-500 hover:text-blok-green-400"
						>
							<SquareFunction className="h-3.5 w-3.5" />
						</button>
						{picker && <UpstreamPicker sources={sources} onPick={pick} onClose={() => setPicker(false)} />}
					</div>
				</label>

				<label className="flex flex-col gap-1">
					<span className="text-[10px] font-medium text-zinc-400">as (per-iteration variable name)</span>
					<input
						aria-label="as"
						value={asText}
						onChange={(event) => setAsText(event.target.value)}
						placeholder="item"
						spellCheck={false}
						className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
					/>
				</label>

				<p className="text-[10px] text-zinc-500">
					Each iteration sets <span className="font-mono">ctx.state.{asText || "<as>"}</span> and{" "}
					<span className="font-mono">ctx.state.{asText || "<as>"}Index</span> — there is no separate `asIndex` field.
				</p>

				{collision && (
					<p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
						"{collision}" (or "{collision}Index") is already used as a step id elsewhere in this workflow. forEach's{" "}
						<span className="font-mono">as</span> shares the same state namespace as step ids — this will silently
						shadow that step, and the runner rejects it at load time.
					</p>
				)}

				<p className="truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px]">
					<span className="text-zinc-500">in:</span> <span className="text-blok-green-300">{inText}</span>
				</p>
			</div>
		</form>
	);
}
