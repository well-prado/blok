import { useWorkflows } from "@/hooks/useWorkflows";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Phase 5.3 — subworkflow structural editor. Unlike branch/forEach/switch/
 * tryCatch/wait, `subworkflow`/`inputs`/`wait`/`dispatch` are TOP-LEVEL
 * fields on the step itself (`V2SubworkflowStepSchema`,
 * core/workflow-helper/src/types/StepOpts.ts:437-585) — there is no nested
 * `step.subworkflow.<field>` config object, `subworkflow` IS the
 * discriminator string. So this editor's prop is the WHOLE raw step (not a
 * sub-object), and `onSave` returns the whole updated step for the caller to
 * merge back — see `WorkflowGraph.tsx`'s `saveSubworkflow`.
 *
 * CONVENTIONS (verified):
 * - `subworkflow` (target name): literal workflow name OR a polymorphic
 *   `$.<path>` / `js/ctx...` expression resolved against the live ctx at
 *   DISPATCH time by `SubworkflowNode.resolveSubworkflowName` (per-request,
 *   unlike `wait.for`/`wait.until` which never get resolved at all — see
 *   core/runner/CLAUDE.md "Polymorphic workflow names (G3)" +
 *   StepOpts.ts:469-479). A `<select>` covers the common literal-name case;
 *   "Custom" falls back to free text for the expression case (paired with
 *   `allowList` server-side, which this editor doesn't expose UI for and
 *   leaves untouched via the `...step` spread on save).
 * - `inputs`: SAME `js/` mapper-prefix convention as regular step `inputs`
 *   — WorkflowNormalizer.ts:604-609 explicitly runs `lowerRefs(inlineInputs)`
 *   over subworkflow inputs before they reach `ctx.config[step.name]`. The
 *   child's schema isn't available client-side (it's a different workflow,
 *   not a catalog node), so this stays a raw-JSON escape hatch — same idiom
 *   as `StepInputsEditor`'s raw mode — rather than a generated form.
 * - `wait` (boolean, default true) / `dispatch` ("in-process" | "http-self",
 *   default "in-process") — StepOpts.ts:489-503, 561-576. Both selects always
 *   write an explicit value; behaviorally identical to omitting them at the
 *   schema defaults, simpler than a tri-state unset/true/false control.
 */

export interface RawSubworkflowStep {
	id?: unknown;
	subworkflow?: unknown;
	inputs?: unknown;
	wait?: unknown;
	dispatch?: unknown;
	allowList?: unknown;
	[key: string]: unknown;
}

export interface SubworkflowEditorProps {
	stepId: string;
	step: RawSubworkflowStep;
	/** The workflow currently being edited — flags a self-recursive dispatch. */
	currentWorkflowName: string;
	pending: boolean;
	error?: string;
	onSave: (step: RawSubworkflowStep) => void;
	onClose: () => void;
}

export function SubworkflowEditor({
	stepId,
	step,
	currentWorkflowName,
	pending,
	error,
	onSave,
	onClose,
}: SubworkflowEditorProps) {
	const workflowsQuery = useWorkflows();
	const workflowNames = useMemo(() => (workflowsQuery.data ?? []).map((w) => w.name), [workflowsQuery.data]);

	const initialTarget = typeof step.subworkflow === "string" ? step.subworkflow : "";
	const [custom, setCustom] = useState(() => initialTarget !== "" && !workflowNames.includes(initialTarget));
	const [selectValue, setSelectValue] = useState(() => (workflowNames.includes(initialTarget) ? initialTarget : ""));
	const [customText, setCustomText] = useState(initialTarget);
	const target = custom ? customText : selectValue;

	const [waitMode, setWaitMode] = useState<"true" | "false">(step.wait === false ? "false" : "true");
	const [dispatch, setDispatch] = useState<"in-process" | "http-self">(
		step.dispatch === "http-self" ? "http-self" : "in-process",
	);
	const [inputsText, setInputsText] = useState(() => JSON.stringify(step.inputs ?? {}, null, 2));
	const [formError, setFormError] = useState<string | null>(null);

	const selfReference = target.trim() !== "" && target.trim() === currentWorkflowName;

	const toggleCustom = () => {
		setCustom((current) => {
			const next = !current;
			if (next) setCustomText(target);
			else setSelectValue(workflowNames.includes(target.trim()) ? target.trim() : (workflowNames[0] ?? ""));
			return next;
		});
	};

	const submit = () => {
		const name = target.trim();
		if (name === "") {
			setFormError("Choose a workflow, or switch to Custom and enter an expression.");
			return;
		}
		let inputs: unknown;
		try {
			inputs = JSON.parse(inputsText || "{}");
			if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("must be an object");
		} catch (parseError) {
			setFormError(`Invalid inputs JSON: ${(parseError as Error).message}`);
			return;
		}
		setFormError(null);
		onSave({
			...step,
			subworkflow: name,
			inputs: inputs as Record<string, unknown>,
			wait: waitMode === "true",
			dispatch,
		});
	};

	return (
		<form
			aria-label={`subworkflow for ${stepId}`}
			className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950/70 px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-zinc-300">
					subworkflow <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save subworkflow
				</button>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					Cancel
				</button>
			</div>

			{error && <p className="mt-2 text-xs text-red-300">{error}</p>}
			{formError && <p className="mt-2 text-xs text-red-300">{formError}</p>}

			<div className="mt-2 flex flex-col gap-2 text-xs">
				<div className="flex flex-col gap-1">
					{/* The toggle button lives OUTSIDE the label — a `<label>` wrapping
					    both the select and a nested `<button>` makes testing-library's
					    label-content matching associate BOTH controls with "Target
					    workflow" (it subtracts each control's own text from the
					    label's text before comparing), which collides with the
					    select's explicit `aria-label` of the same text. */}
					<div className="flex items-center gap-1.5">
						<span className="text-[10px] font-medium text-zinc-400">Target workflow</span>
						<button
							type="button"
							onClick={toggleCustom}
							className="ml-auto rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							{custom ? "Pick from list" : "Custom"}
						</button>
					</div>
					{custom ? (
						<input
							aria-label="Custom workflow name or expression"
							value={customText}
							onChange={(event) => setCustomText(event.target.value)}
							placeholder="send-receipt-email or js/ctx.req.body.kind"
							spellCheck={false}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						/>
					) : (
						<select
							aria-label="Target workflow"
							value={selectValue}
							onChange={(event) => setSelectValue(event.target.value)}
							disabled={workflowsQuery.isLoading}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400 disabled:opacity-40"
						>
							<option value="">{workflowsQuery.isLoading ? "Loading workflows…" : "— choose —"}</option>
							{workflowNames.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
					)}
				</div>

				{selfReference && (
					<p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
						This targets the CURRENT workflow ("{currentWorkflowName}") — a self-recursive call. The runner caps nesting
						depth (default 10, <span className="font-mono">BLOK_MAX_SUBWORKFLOW_DEPTH</span>) but a recursion base case
						is still your responsibility.
					</p>
				)}

				<p className="truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px]">
					<span className="text-zinc-500">subworkflow:</span> <span className="text-blok-green-300">{target}</span>
				</p>

				<label className="flex flex-col gap-1">
					<span className="text-[10px] font-medium text-zinc-400">
						inputs (JSON — passed to the child as its request body)
					</span>
					<textarea
						aria-label="inputs"
						value={inputsText}
						onChange={(event) => setInputsText(event.target.value)}
						rows={6}
						spellCheck={false}
						className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
					/>
					<span className="text-[10px] text-zinc-500">Values starting with js/ are evaluated at run time.</span>
				</label>

				<div className="flex gap-2">
					<label className="flex flex-1 flex-col gap-1">
						<span className="text-[10px] font-medium text-zinc-400">wait</span>
						<select
							aria-label="wait"
							value={waitMode}
							onChange={(event) => setWaitMode(event.target.value as "true" | "false")}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						>
							<option value="true">true — block until child completes (default)</option>
							<option value="false">false — fire-and-forget</option>
						</select>
					</label>
					<label className="flex flex-1 flex-col gap-1">
						<span className="text-[10px] font-medium text-zinc-400">dispatch</span>
						<select
							aria-label="dispatch"
							value={dispatch}
							onChange={(event) => setDispatch(event.target.value as "in-process" | "http-self")}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						>
							<option value="in-process">in-process (default)</option>
							<option value="http-self">http-self</option>
						</select>
					</label>
				</div>
			</div>
		</form>
	);
}
