import { useState } from "react";

/**
 * Phase 5.3 — wait structural editor: `for` (relative duration) /
 * `until` (absolute deadline), mutually exclusive per
 * `V2WaitStepSchema.refine` (core/workflow-helper/src/types/StepOpts.ts:680-683)
 * AND enforced again at load time by `WorkflowNormalizer.normalizeWaitStep`
 * (core/runner/src/workflow/WorkflowNormalizer.ts:636-639, throws
 * "must set exactly one of `wait.for` or `wait.until`" if both or neither
 * are set) — so there is no "precedence" to document: setting both is a
 * hard validation error, not a soft tiebreak. The mode toggle below enforces
 * exactly-one-active by construction.
 *
 * CONVENTION (load-bearing, verified — do not add an UpstreamPicker here):
 * unlike `forEach.in`/`switch.on` (`js/` mapper prefix) or `branch.when`
 * (raw ctx JS), `wait.for`/`wait.until` accept NO runtime expression at
 * all. `normalizeWaitStep` runs once inside `normalizeWorkflow` at
 * WORKFLOW LOAD time — before any request `ctx` exists — and reads
 * `wait.for`/`wait.until` as literal number|string with no `lowerRefs`/
 * Mapper pass (contrast with subworkflow's `inputs`, which explicitly does
 * get `lowerRefs` — WorkflowNormalizer.ts:604-609). At RUN time,
 * `RunnerSteps.ts`'s `computeDeadline` (lines 445-464) only ever calls
 * `Number(waitUntil)` or `Date.parse(waitUntil)` on the stored value — no
 * ctx/Mapper resolution either. Any expression string written here — a
 * handle ref, a `tpl`, or a raw `js/ctx...` — is stored VERBATIM and fails
 * to parse as a number or date at run time (RunnerSteps.ts:456-458 throws a
 * clear "cannot parse" error). `wait` is LITERAL-ONLY, in both fields.
 *
 * `examples/v05-primitives/09-polling-with-backoff.json` used to encode a
 * computed backoff here and could never have worked; it now uses a literal
 * interval and documents the limitation. Dynamic delays belong inside a
 * node until `wait` grows a resolution pass.
 *
 * `for` grammar mirrors `DurationSchema` (core/workflow-helper/src/types/
 * TriggerOpts.ts:167-175): a non-negative integer (ms) or `<int><unit>`
 * with unit in ms|s|m|h|d. `until` mirrors `computeDeadline`: ms-since-epoch
 * (number, or a numeric string) or an ISO/`Date.parse`-able date string.
 */

export interface RawWait {
	for?: unknown;
	until?: unknown;
	[key: string]: unknown;
}

export interface WaitEditorProps {
	stepId: string;
	wait: RawWait;
	pending: boolean;
	error?: string;
	onSave: (wait: RawWait) => void;
	onClose: () => void;
}

type WaitMode = "for" | "until";

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Mirrors `DurationSchema` exactly — see the file header for the citation. */
function parseForText(text: string): { value: number | string; ms: number } | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	if (/^\d+$/.test(trimmed)) {
		const n = Number(trimmed);
		return { value: n, ms: n };
	}
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(trimmed);
	if (!match) return null;
	const n = Number.parseInt(match[1] as string, 10);
	return { value: trimmed, ms: n * (DURATION_UNIT_MS[match[2] as string] as number) };
}

/** Mirrors `RunnerSteps.ts`'s `computeDeadline` exactly — see the file header for the citation. */
function parseUntilText(text: string): { value: number | string; deadline: number } | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const asNum = Number(trimmed);
	if (!Number.isNaN(asNum)) return { value: asNum, deadline: asNum };
	const parsed = Date.parse(trimmed);
	if (!Number.isNaN(parsed)) return { value: trimmed, deadline: parsed };
	return null;
}

function initialMode(wait: RawWait): WaitMode {
	return wait.until !== undefined && wait.for === undefined ? "until" : "for";
}

function initialText(value: unknown): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : String(value);
}

export function WaitEditor({ stepId, wait, pending, error, onSave, onClose }: WaitEditorProps) {
	const [mode, setMode] = useState<WaitMode>(() => initialMode(wait));
	const [forText, setForText] = useState(() => initialText(wait.for));
	const [untilText, setUntilText] = useState(() => initialText(wait.until));
	const [formError, setFormError] = useState<string | null>(null);

	const forParsed = parseForText(forText);
	const untilParsed = parseUntilText(untilText);

	const submit = () => {
		if (mode === "for") {
			if (!forParsed) {
				setFormError(
					'Enter a non-negative integer (ms) or a duration string — "<integer><unit>" with unit ms, s, m, h, or d, e.g. "500ms", "30s", "5m", "2h", "1d".',
				);
				return;
			}
			setFormError(null);
			onSave({ for: forParsed.value });
			return;
		}
		if (!untilParsed) {
			setFormError("Enter ms-since-epoch (a number) or a date string Date.parse can read, e.g. an ISO timestamp.");
			return;
		}
		setFormError(null);
		onSave({ until: untilParsed.value });
	};

	return (
		<form
			aria-label={`wait for ${stepId}`}
			className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950/70 px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-zinc-300">
					wait <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Save wait
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
				`for` and `until` are mutually exclusive — the runner rejects a wait step with both or neither set.
			</p>

			{error && <p className="mt-2 text-xs text-red-300">{error}</p>}
			{formError && <p className="mt-2 text-xs text-red-300">{formError}</p>}

			<div className="mt-2 flex gap-1.5">
				<button
					type="button"
					onClick={() => setMode("for")}
					className={
						mode === "for"
							? "rounded-md border border-blok-green-500/50 bg-blok-green-500/10 px-2 py-1 text-[11px] font-medium text-blok-green-300"
							: "rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
					}
				>
					for (relative)
				</button>
				<button
					type="button"
					onClick={() => setMode("until")}
					className={
						mode === "until"
							? "rounded-md border border-blok-green-500/50 bg-blok-green-500/10 px-2 py-1 text-[11px] font-medium text-blok-green-300"
							: "rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
					}
				>
					until (absolute)
				</button>
			</div>

			{mode === "for" ? (
				<div className="mt-2 flex flex-col gap-1">
					<label htmlFor="wait-for-input" className="text-[10px] font-medium text-zinc-400">
						for (duration)
					</label>
					<input
						id="wait-for-input"
						aria-label="for"
						value={forText}
						onChange={(event) => setForText(event.target.value)}
						placeholder="30s"
						spellCheck={false}
						className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
					/>
					<p className="text-[10px] text-zinc-500">Not an expression — a literal ms number or duration string.</p>
					<p className="truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px]">
						{forParsed ? (
							<>
								<span className="text-zinc-500">fires ≈</span>{" "}
								<span className="text-blok-green-300">{new Date(Date.now() + forParsed.ms).toLocaleString()}</span>
							</>
						) : (
							<span className="text-zinc-600">enter a duration to preview</span>
						)}
					</p>
				</div>
			) : (
				<div className="mt-2 flex flex-col gap-1">
					<label htmlFor="wait-until-input" className="text-[10px] font-medium text-zinc-400">
						until (deadline)
					</label>
					<input
						id="wait-until-input"
						aria-label="until"
						value={untilText}
						onChange={(event) => setUntilText(event.target.value)}
						placeholder="2026-12-31T00:00:00Z"
						spellCheck={false}
						className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
					/>
					<p className="text-[10px] text-zinc-500">
						Not an expression — ms-since-epoch or a date string, resolved once at run time.
					</p>
					<p className="truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px]">
						{untilParsed ? (
							<>
								<span className="text-zinc-500">resolves to</span>{" "}
								<span className="text-blok-green-300">{new Date(untilParsed.deadline).toLocaleString()}</span>
							</>
						) : (
							<span className="text-zinc-600">enter a date to preview</span>
						)}
					</p>
				</div>
			)}
		</form>
	);
}
