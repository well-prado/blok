import { UpstreamPicker } from "@/components/trace/UpstreamPicker";
import { formatCaseLiteral, parseCaseLiteral } from "@/lib/switchCase";
import type { UpstreamSource } from "@/lib/upstreamSources";
import { cn } from "@/lib/utils";
import { Loader2, Plus, SquareFunction, Trash2 } from "lucide-react";
import { useState } from "react";

/**
 * Phase 5.3 — switch structural editor: `on` discriminant + case rows,
 * lowered straight onto the step's `switch` config. Mirrors `BranchEditor`'s
 * shape; the prop is named `switchConfig` (not `switch`) because `switch` is
 * a reserved word and can't be a destructured binding name.
 *
 * `on` resolves through the SAME blueprint mapper regular step `inputs` use
 * (`js/...` prefix — core/runner/src/Configuration.ts:337-339), NOT raw
 * `ctx.*` JS like branch `when` (ADR 0004) — so the `UpstreamPicker` below is
 * used WITHOUT `raw`, unlike `BranchEditor`'s.
 *
 * Verified IR shape (core/workflow-helper/src/types/StepOpts.ts:814-852,
 * confirmed live by irEditOps.test.ts:725 and the real
 * triggers/http/workflows/json/v05-nested-control-flow.json fixture):
 * `{ id, switch: { on, cases: [{ when, do: Step[] }], default?: Step[] } }`.
 * The case-entry match-literal key is `when`, NOT `case` — the runtime
 * `V2SwitchStepSchema` (`.strict()`) rejects any other key.
 */

export interface RawSwitchCase {
	when?: unknown;
	do?: unknown;
	[key: string]: unknown;
}

export interface RawSwitch {
	on?: unknown;
	cases?: RawSwitchCase[];
	default?: unknown;
	[key: string]: unknown;
}

export interface SwitchEditorProps {
	stepId: string;
	switchConfig: RawSwitch;
	/** Upstream handle/value picker sources — computed by the caller via `upstreamSources()`. */
	sources: UpstreamSource[];
	pending: boolean;
	error?: string;
	onSave: (switchConfig: RawSwitch) => void;
	onClose: () => void;
}

function armCount(arm: unknown): number {
	return Array.isArray(arm) ? arm.length : 0;
}

interface CaseRow {
	text: string;
	do: unknown;
}

export function SwitchEditor({ stepId, switchConfig, sources, pending, error, onSave, onClose }: SwitchEditorProps) {
	const [onText, setOnText] = useState(typeof switchConfig.on === "string" ? switchConfig.on : "");
	const [rows, setRows] = useState<CaseRow[]>(() =>
		Array.isArray(switchConfig.cases)
			? switchConfig.cases.map((c) => ({ text: formatCaseLiteral(c?.when), do: c?.do }))
			: [],
	);
	const [picker, setPicker] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
	const [formError, setFormError] = useState<string | null>(null);

	const submit = () => {
		if (onText.trim() === "") {
			setFormError('"on" is required — the value to match cases against.');
			return;
		}
		if (rows.length === 0) {
			setFormError("At least one case is required.");
			return;
		}
		if (rows.some((row) => row.text.trim() === "")) {
			setFormError("Every case needs a match value.");
			return;
		}
		setFormError(null);
		onSave({
			...switchConfig,
			on: onText,
			cases: rows.map((row) => ({ when: parseCaseLiteral(row.text), do: row.do })),
		});
	};

	const pick = (expr: string) => {
		setOnText(expr);
		setPicker(false);
	};

	const setRowText = (index: number, text: string) => {
		setRows((current) => current.map((row, i) => (i === index ? { ...row, text } : row)));
	};

	const addCase = () => {
		setRows((current) => [...current, { text: "", do: [] }]);
	};

	const removeCase = (index: number) => {
		const row = rows[index];
		if (armCount(row?.do) > 0 && confirmRemove !== index) {
			setConfirmRemove(index);
			return;
		}
		setRows((current) => current.filter((_, i) => i !== index));
		setConfirmRemove(null);
	};

	return (
		<form
			aria-label={`switch for ${stepId}`}
			className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950/70 px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-zinc-300">
					switch <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save switch
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
				default: {armCount(switchConfig.default)} step{armCount(switchConfig.default) === 1 ? "" : "s"}
			</p>

			{error && <p className="mt-2 text-xs text-red-300">{error}</p>}
			{formError && <p className="mt-2 text-xs text-red-300">{formError}</p>}

			<div className="mt-2 flex flex-col gap-2 text-xs">
				<label className="flex flex-col gap-1">
					<span className="text-[10px] font-medium text-zinc-400">on (value to match)</span>
					<div className="relative flex w-full min-w-0 items-center gap-1">
						<input
							aria-label="on"
							value={onText}
							onChange={(event) => setOnText(event.target.value)}
							placeholder="js/ctx.state.step.kind"
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

				<p className="truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px]">
					<span className="text-zinc-500">on:</span> <span className="text-blok-green-300">{onText}</span>
				</p>

				<div className="mt-1 flex items-center justify-between">
					<span className="text-[10px] font-medium text-zinc-400">Cases</span>
					<button
						type="button"
						onClick={addCase}
						className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
					>
						<Plus className="h-3 w-3" /> Add case
					</button>
				</div>

				<ul className="flex flex-col gap-1.5">
					{rows.map((row, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id — this list only grows/shrinks by index, never reorders
						<li key={index} className="flex items-center gap-1.5">
							<input
								aria-label={`Case ${index + 1} value`}
								value={row.text}
								onChange={(event) => setRowText(index, event.target.value)}
								placeholder="value"
								spellCheck={false}
								className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
							/>
							<span className="shrink-0 text-[10px] text-zinc-500">
								{armCount(row.do)} step{armCount(row.do) === 1 ? "" : "s"}
							</span>
							<button
								type="button"
								title={
									armCount(row.do) > 0 && confirmRemove !== index
										? `Removing this case deletes its ${armCount(row.do)} step(s)`
										: "Remove case"
								}
								onClick={() => removeCase(index)}
								className={cn(
									"inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[10px]",
									confirmRemove === index
										? "border-red-400/60 bg-red-500/15 text-red-200 hover:bg-red-500/25"
										: "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
								)}
							>
								<Trash2 className="h-3 w-3" />
								{confirmRemove === index ? "Confirm" : ""}
							</button>
						</li>
					))}
					{rows.length === 0 && <li className="text-[10px] text-zinc-600">No cases yet.</li>}
				</ul>
			</div>
		</form>
	);
}
