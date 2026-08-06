import { UpstreamPicker } from "@/components/trace/UpstreamPicker";
import { type Comparator, lowerCondition, parseCondition } from "@/lib/branchCondition";
import type { UpstreamSource } from "@/lib/upstreamSources";
import { cn } from "@/lib/utils";
import { Loader2, SquareFunction } from "lucide-react";
import { useState } from "react";

/**
 * Phase 5.3 — branch `when` structural editor: [left] [comparator] [right],
 * lowered to the raw `ctx.*` string `@blokjs/if-else` evaluates (ADR 0004).
 * Mirrors `StepInputsEditorProps` naming/shape so the drawer host stays
 * uniform (see `WorkflowGraph.tsx`'s `startEditInputs`/`editingInputsStepId`).
 */

export interface RawBranch {
	when?: unknown;
	then?: unknown;
	else?: unknown;
	[key: string]: unknown;
}

export interface BranchEditorProps {
	stepId: string;
	branch: RawBranch;
	/** Upstream handle/value picker sources — computed by the caller via `upstreamSources()`. */
	sources: UpstreamSource[];
	pending: boolean;
	error?: string;
	onSave: (branch: RawBranch) => void;
	onClose: () => void;
}

const COMPARATORS: Array<{ value: Comparator; label: string }> = [
	{ value: "===", label: "===" },
	{ value: "!==", label: "!==" },
	{ value: ">", label: ">" },
	{ value: ">=", label: ">=" },
	{ value: "<", label: "<" },
	{ value: "<=", label: "<=" },
];

function armCount(arm: unknown): number {
	return Array.isArray(arm) ? arm.length : 0;
}

export function BranchEditor({ stepId, branch, sources, pending, error, onSave, onClose }: BranchEditorProps) {
	const whenText = typeof branch.when === "string" ? branch.when : "";
	const [parsed] = useState(() => parseCondition(whenText));
	const [raw, setRaw] = useState(parsed === null);
	const [rawText, setRawText] = useState(whenText);
	const [left, setLeft] = useState(parsed?.left ?? "");
	const [comparator, setComparator] = useState<Comparator | "">(parsed?.comparator ?? "");
	const [right, setRight] = useState(parsed?.right ?? "");
	const [negated, setNegated] = useState(parsed?.negated ?? false);
	const [picker, setPicker] = useState<"left" | "right" | null>(null);
	const [formError, setFormError] = useState<string | null>(null);

	const lowered = lowerCondition({ left, comparator: comparator || undefined, right, negated });

	const submit = () => {
		if (raw) {
			if (rawText.trim() === "") {
				setFormError("Condition cannot be empty.");
				return;
			}
			setFormError(null);
			onSave({ ...branch, when: rawText });
			return;
		}
		if (left.trim() === "") {
			setFormError("Left operand is required.");
			return;
		}
		if (comparator && right.trim() === "") {
			setFormError("Right operand is required.");
			return;
		}
		setFormError(null);
		onSave({ ...branch, when: lowered });
	};

	const pick = (expr: string) => {
		if (picker === "left") setLeft(expr);
		else if (picker === "right") setRight(expr);
		setPicker(null);
	};

	return (
		<form
			aria-label={`Condition for ${stepId}`}
			className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950/70 px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-zinc-300">
					Condition for <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="button"
					onClick={() => setRaw((current) => !current)}
					className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					{raw ? "Structured" : "Raw JS"}
				</button>
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save condition
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
				then: {armCount(branch.then)} step{armCount(branch.then) === 1 ? "" : "s"} · else: {armCount(branch.else)} step
				{armCount(branch.else) === 1 ? "" : "s"}
			</p>

			{error && <p className="mt-2 text-xs text-red-300">{error}</p>}
			{formError && <p className="mt-2 text-xs text-red-300">{formError}</p>}

			{parsed === null && whenText !== "" && (
				<p className="mt-2 text-[10px] text-amber-300">
					This condition is too complex for the structural editor, so it stays in raw JS.
				</p>
			)}

			{raw ? (
				<>
					<textarea
						aria-label="Raw condition JS"
						value={rawText}
						onChange={(event) => setRawText(event.target.value)}
						rows={4}
						spellCheck={false}
						className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
					/>
					<p className="mt-1 text-[10px] text-zinc-500">
						Evaluated as plain JavaScript against <span className="font-mono">ctx</span> — e.g.{" "}
						<span className="font-mono">ctx.state.step.field === "x"</span>.
					</p>
				</>
			) : (
				<div className="mt-2 flex flex-col gap-2 text-xs">
					{/* Stacked, not a single row: the config drawer is ~295px wide and
					    the comparator select's intrinsic width squeezed side-by-side
					    operands down to ~40px each. */}
					<div className="flex flex-col gap-1.5">
						<div className="relative flex w-full min-w-0 items-center gap-1">
							<input
								aria-label="Left operand"
								value={left}
								onChange={(event) => setLeft(event.target.value)}
								placeholder="ctx.state.step.field"
								spellCheck={false}
								className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
							/>
							<button
								type="button"
								title="Insert a value from an upstream step"
								onClick={() => setPicker((current) => (current === "left" ? null : "left"))}
								className="shrink-0 text-zinc-500 hover:text-blok-green-400"
							>
								<SquareFunction className="h-3.5 w-3.5" />
							</button>
							{picker === "left" && (
								<UpstreamPicker raw sources={sources} onPick={pick} onClose={() => setPicker(null)} />
							)}
						</div>

						<select
							aria-label="Comparator"
							value={comparator}
							onChange={(event) => setComparator(event.target.value as Comparator | "")}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						>
							<option value="">is true (no comparison)</option>
							{COMPARATORS.map((c) => (
								<option key={c.value} value={c.value}>
									{c.label}
								</option>
							))}
						</select>

						{comparator && (
							<div className="relative flex w-full min-w-0 items-center gap-1">
								<input
									aria-label="Right operand"
									value={right}
									onChange={(event) => setRight(event.target.value)}
									placeholder='ctx.state.step.field or "value"'
									spellCheck={false}
									className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
								/>
								<button
									type="button"
									title="Insert a value from an upstream step"
									onClick={() => setPicker((current) => (current === "right" ? null : "right"))}
									className="shrink-0 text-zinc-500 hover:text-blok-green-400"
								>
									<SquareFunction className="h-3.5 w-3.5" />
								</button>
								{picker === "right" && (
									<UpstreamPicker raw sources={sources} onPick={pick} onClose={() => setPicker(null)} />
								)}
							</div>
						)}
					</div>

					<label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
						<input type="checkbox" checked={negated} onChange={(event) => setNegated(event.target.checked)} />
						Negate (!)
					</label>

					<p
						className={cn("truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px]")}
					>
						<span className="text-zinc-500">when:</span> <span className="text-blok-green-300">{lowered}</span>
					</p>
				</div>
			)}
		</form>
	);
}
