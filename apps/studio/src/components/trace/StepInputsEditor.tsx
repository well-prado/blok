import { UpstreamPicker } from "@/components/trace/UpstreamPicker";
import type { NodeCatalogEntry } from "@/lib/api";
import { upstreamSources } from "@/lib/upstreamSources";
import { cn } from "@/lib/utils";
import type { NodeRun } from "@/types";
import { Loader2, SquareFunction } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Phase 5.3 — schema-driven step-inputs editor. Renders a form from the
 * node's reflected JSON Schema (the catalog's `inputSchema`), following
 * atomic-canvas's DrawerConfig/groupProperties model flattened to one level:
 * top-level primitives get typed fields, everything else (objects, arrays,
 * unions) gets a per-field JSON textarea. Any string field may hold a
 * `js/...` expression — the runner's mapper resolves it at run time.
 *
 * Phase 5.3 also adds an optional "Settings" tab for the step-level
 * reliability/state knobs (`as`, `spread`, `ephemeral`, `idempotencyKey`,
 * `retry`, `maxDuration` — see `core/workflow-helper/src/types/StepOpts.ts`
 * `V2RegularStepSchema`). The tab only renders when a caller passes
 * `onSaveSettings`; existing callers that don't pass it see no change.
 */

interface SchemaProperty {
	type?: string;
	description?: string;
	enum?: unknown[];
	default?: unknown;
}

interface InputsSchema {
	type?: string;
	properties?: Record<string, SchemaProperty>;
	required?: string[];
}

export interface StepInputsEditorProps {
	stepId: string;
	schema: unknown;
	inputs: Record<string, unknown>;
	pending: boolean;
	error?: string;
	/** Drawer layout: single-column fields, no bottom border. */
	narrow?: boolean;
	/**
	 * Upstream handle/value picker inputs (Phase 5.3). All optional — when
	 * `definition` is absent the picker button still renders but every field
	 * shows only the trigger source (no step is known to be upstream).
	 */
	definition?: unknown;
	catalog?: NodeCatalogEntry[];
	lastRunNodes?: NodeRun[];
	onSave: (inputs: Record<string, unknown>) => void;
	onClose: () => void;
	/**
	 * Phase 5.3 Settings tab (optional). `settings` is the step's current
	 * step-level fields (`as`/`spread`/`ephemeral`/`idempotencyKey`/`retry`/
	 * `maxDuration`) as already present on the raw step object — pass
	 * whatever subset exists; missing keys default to "unset" in the form.
	 * The "Settings" tab (and the whole settings UI) only renders when
	 * `onSaveSettings` is provided. `onSaveSettings` receives an object that
	 * contains ONLY the keys the author set — blank/default fields are
	 * omitted, never written as `""` or `false`, mirroring how `onSave`
	 * treats blank input fields and how `toggleStepSkip` in `irEditOps`
	 * deletes rather than falsifies a key.
	 */
	settings?: Record<string, unknown>;
	onSaveSettings?: (settings: Record<string, unknown>) => void;
}

type FieldKind = "string" | "number" | "boolean" | "enum" | "json";

interface Field {
	name: string;
	kind: FieldKind;
	required: boolean;
	description?: string;
	options?: unknown[];
}

function fieldKind(prop: SchemaProperty): FieldKind {
	if (Array.isArray(prop.enum) && prop.enum.length > 0) return "enum";
	if (prop.type === "string") return "string";
	if (prop.type === "number" || prop.type === "integer") return "number";
	if (prop.type === "boolean") return "boolean";
	return "json";
}

/** Initial editor text for a field from the current inputs value. */
function initialText(kind: FieldKind, value: unknown): string {
	if (value === undefined) return "";
	if (kind === "json") return JSON.stringify(value, null, 2);
	if (kind === "boolean") return String(value);
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function buildFields(schema: unknown): Field[] {
	const s = (schema ?? {}) as InputsSchema;
	const properties = s.properties ?? {};
	const required = new Set(s.required ?? []);
	return Object.entries(properties).map(([name, prop]) => ({
		name,
		kind: fieldKind(prop ?? {}),
		required: required.has(name),
		description: prop?.description,
		options: prop?.enum,
	}));
}

// =============================================================================
// Settings tab — step-level reliability/state knobs (Phase 5.3).
//
// Field-by-field source of truth: core/workflow-helper/src/types/StepOpts.ts
// `V2RegularStepSchema` (as/spread/ephemeral/idempotencyKey/retry/
// maxDuration) plus its `.refine` for the `as`/`spread` mutual exclusion,
// cross-checked against core/runner/src/workflow/WorkflowNormalizer.ts
// `normalizeRegularStep` which enforces the same exclusion again at load
// time. `retry.maxAttempts` is 1-20 (int); `minTimeoutInMs`/`maxTimeoutInMs`
// are non-negative ints with min <= max; `factor` is a number >= 1.
// `maxDuration` is `DurationSchema`: a non-negative integer (ms) or a
// string matching /^\d+(ms|s|m|h|d)$/.
// =============================================================================

const MAX_DURATION_PATTERN = /^\d+(ms|s|m|h|d)$/;

function strToText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numToText(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

interface RetryTexts {
	maxAttempts: string;
	minTimeoutInMs: string;
	maxTimeoutInMs: string;
	factor: string;
}

/** Build the `retry` object from form text, or an error, or neither (unset). */
function buildRetry(texts: RetryTexts): { value?: Record<string, unknown>; error?: string } {
	const maxAttemptsText = texts.maxAttempts.trim();
	const minText = texts.minTimeoutInMs.trim();
	const maxText = texts.maxTimeoutInMs.trim();
	const factorText = texts.factor.trim();
	if (maxAttemptsText === "") {
		if (minText !== "" || maxText !== "" || factorText !== "") {
			return { error: "retry.maxAttempts is required when setting minTimeoutInMs/maxTimeoutInMs/factor" };
		}
		return {};
	}
	const maxAttempts = Number(maxAttemptsText);
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
		return { error: "retry.maxAttempts must be an integer between 1 and 20" };
	}
	const retry: Record<string, unknown> = { maxAttempts };
	let min: number | undefined;
	let max: number | undefined;
	if (minText !== "") {
		min = Number(minText);
		if (!Number.isInteger(min) || min < 0) return { error: "retry.minTimeoutInMs must be a non-negative integer" };
		retry.minTimeoutInMs = min;
	}
	if (maxText !== "") {
		max = Number(maxText);
		if (!Number.isInteger(max) || max < 0) return { error: "retry.maxTimeoutInMs must be a non-negative integer" };
		retry.maxTimeoutInMs = max;
	}
	if (min !== undefined && max !== undefined && min > max) {
		return { error: "retry.minTimeoutInMs must be <= retry.maxTimeoutInMs" };
	}
	if (factorText !== "") {
		const factor = Number(factorText);
		if (!Number.isFinite(factor) || factor < 1) return { error: "retry.factor must be a number >= 1" };
		retry.factor = factor;
	}
	return { value: retry };
}

/** Parse the `maxDuration` field: blank = unset, digits = ms, or a duration string. */
function buildMaxDuration(text: string): { value?: number | string; error?: string } {
	const trimmed = text.trim();
	if (trimmed === "") return {};
	if (/^\d+$/.test(trimmed)) return { value: Number(trimmed) };
	if (MAX_DURATION_PATTERN.test(trimmed)) return { value: trimmed };
	return { error: 'maxDuration must be a non-negative integer (ms) or a duration string like "30s", "5m", "2h", "1d"' };
}

export function StepInputsEditor({
	stepId,
	schema,
	inputs,
	pending,
	error,
	narrow,
	definition,
	catalog,
	lastRunNodes,
	onSave,
	onClose,
	settings,
	onSaveSettings,
}: StepInputsEditorProps) {
	const fields = useMemo(() => buildFields(schema), [schema]);
	const sources = useMemo(
		() => upstreamSources(definition, stepId, catalog, lastRunNodes),
		[definition, stepId, catalog, lastRunNodes],
	);
	const [pickerFor, setPickerFor] = useState<string | null>(null);
	const knownFieldNames = useMemo(() => new Set(fields.map((field) => field.name)), [fields]);
	// Inputs the schema doesn't describe (or when reflection failed) are only
	// editable through the raw JSON panel, which also serves as the escape
	// hatch the plan calls for.
	const extraInputs = useMemo(
		() => Object.fromEntries(Object.entries(inputs).filter(([key]) => !knownFieldNames.has(key))),
		[inputs, knownFieldNames],
	);
	const [raw, setRaw] = useState(fields.length === 0);
	const [rawText, setRawText] = useState(() => JSON.stringify(inputs, null, 2));
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((field) => [field.name, initialText(field.kind, inputs[field.name])])),
	);
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

	// Settings tab — only meaningful when the host wired onSaveSettings.
	const hasSettings = typeof onSaveSettings === "function";
	const [activeTab, setActiveTab] = useState<"inputs" | "settings">("inputs");
	const [asText, setAsText] = useState(() => strToText(settings?.as));
	const [spread, setSpread] = useState(() => settings?.spread === true);
	const [ephemeral, setEphemeral] = useState(() => settings?.ephemeral === true);
	const [idempotencyKey, setIdempotencyKey] = useState(() => strToText(settings?.idempotencyKey));
	const initialRetry = (settings?.retry ?? {}) as Record<string, unknown>;
	const [maxAttemptsText, setMaxAttemptsText] = useState(() => numToText(initialRetry.maxAttempts));
	const [minTimeoutText, setMinTimeoutText] = useState(() => numToText(initialRetry.minTimeoutInMs));
	const [maxTimeoutText, setMaxTimeoutText] = useState(() => numToText(initialRetry.maxTimeoutInMs));
	const [factorText, setFactorText] = useState(() => numToText(initialRetry.factor));
	const [maxDurationText, setMaxDurationText] = useState(() => {
		const value = settings?.maxDuration;
		return typeof value === "number" || typeof value === "string" ? String(value) : "";
	});
	const [settingsErrors, setSettingsErrors] = useState<Record<string, string>>({});

	const insertValue = (fieldName: string, expr: string) => {
		setValues((current) => ({ ...current, [fieldName]: expr }));
		setPickerFor(null);
	};

	const handleAsChange = (value: string) => {
		setAsText(value);
		if (value.trim() !== "" && spread) setSpread(false);
	};
	const handleSpreadChange = (checked: boolean) => {
		setSpread(checked);
		if (checked && asText.trim() !== "") setAsText("");
	};

	const submit = () => {
		if (raw) {
			try {
				const parsed = JSON.parse(rawText || "{}");
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
				onSave(parsed as Record<string, unknown>);
			} catch (parseError) {
				setFieldErrors({ __raw: `Invalid JSON: ${(parseError as Error).message}` });
			}
			return;
		}

		const next: Record<string, unknown> = { ...extraInputs };
		const errors: Record<string, string> = {};
		for (const field of fields) {
			const text = values[field.name] ?? "";
			if (text.trim() === "") continue; // blank = unset; use raw JSON for literal empty strings
			if (field.kind === "number") {
				// A js/ expression stays a string for the runtime mapper.
				if (text.startsWith("js/")) {
					next[field.name] = text;
					continue;
				}
				const parsed = Number(text);
				if (Number.isNaN(parsed)) {
					errors[field.name] = "Not a number (or js/ expression)";
					continue;
				}
				next[field.name] = parsed;
			} else if (field.kind === "boolean") {
				if (text === "true" || text === "false") next[field.name] = text === "true";
				else next[field.name] = text; // js/ expression or mapper string
			} else if (field.kind === "json") {
				try {
					next[field.name] = JSON.parse(text);
				} catch {
					// Not JSON — keep as a string so `js/...` expressions work.
					next[field.name] = text;
				}
			} else {
				next[field.name] = text;
			}
		}
		if (Object.keys(errors).length > 0) {
			setFieldErrors(errors);
			return;
		}
		setFieldErrors({});
		onSave(next);
	};

	const submitSettings = () => {
		const errors: Record<string, string> = {};
		const next: Record<string, unknown> = {};

		const trimmedAs = asText.trim();
		if (trimmedAs !== "") next.as = trimmedAs;
		if (spread) next.spread = true;
		if (ephemeral) next.ephemeral = true;

		const trimmedKey = idempotencyKey.trim();
		if (trimmedKey !== "") next.idempotencyKey = trimmedKey;

		const retryResult = buildRetry({
			maxAttempts: maxAttemptsText,
			minTimeoutInMs: minTimeoutText,
			maxTimeoutInMs: maxTimeoutText,
			factor: factorText,
		});
		if (retryResult.error) errors.retry = retryResult.error;
		else if (retryResult.value) next.retry = retryResult.value;

		const durationResult = buildMaxDuration(maxDurationText);
		if (durationResult.error) errors.maxDuration = durationResult.error;
		else if (durationResult.value !== undefined) next.maxDuration = durationResult.value;

		if (Object.keys(errors).length > 0) {
			setSettingsErrors(errors);
			return;
		}
		setSettingsErrors({});
		onSaveSettings?.(next);
	};

	const controlClass =
		"w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400";
	const settingsIdPrefix = `step-settings-${stepId}`;

	return (
		<form
			aria-label={`Inputs for ${stepId}`}
			className={cn(
				"bg-zinc-950/70 px-3 py-2",
				narrow ? "flex min-h-0 flex-1 flex-col overflow-y-auto" : "border-b border-zinc-800",
			)}
			onSubmit={(event) => {
				event.preventDefault();
				if (hasSettings && activeTab === "settings") {
					submitSettings();
					return;
				}
				submit();
			}}
		>
			<div className={cn("flex items-center gap-2", narrow && "flex-wrap")}>
				<span className="text-xs font-medium text-zinc-300">
					{activeTab === "settings" ? "Settings for" : "Inputs for"} <span className="font-mono">{stepId}</span>
				</span>
				{hasSettings && (
					<div
						role="tablist"
						aria-label="Step editor tabs"
						className="flex items-center gap-0.5 rounded-md border border-zinc-800 p-0.5"
					>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "inputs"}
							onClick={() => setActiveTab("inputs")}
							className={cn(
								"rounded px-2 py-0.5 text-[10px]",
								activeTab === "inputs" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
							)}
						>
							Inputs
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "settings"}
							onClick={() => setActiveTab("settings")}
							className={cn(
								"rounded px-2 py-0.5 text-[10px]",
								activeTab === "settings" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
							)}
						>
							Settings
						</button>
					</div>
				)}
				{activeTab === "inputs" && (
					<>
						<button
							type="button"
							onClick={() => setRaw((current) => !current)}
							className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							{raw ? "Form" : "Raw JSON"}
						</button>
						<span className="text-[10px] text-zinc-500">Values starting with js/ are evaluated at run time.</span>
					</>
				)}
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{" "}
					{activeTab === "settings" ? "Save settings" : "Save inputs"}
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
			{activeTab === "inputs" && fieldErrors.__raw && <p className="mt-2 text-xs text-red-300">{fieldErrors.__raw}</p>}
			{activeTab === "settings" ? (
				<div className="mt-2 flex flex-col gap-3">
					<div className="text-xs">
						<div className="mb-0.5 flex items-baseline gap-1.5">
							<label htmlFor={`${settingsIdPrefix}-as`} className="font-mono text-zinc-200">
								as
							</label>
							<span className="text-[10px] text-zinc-500">
								Rename this step's state slot — store the output at state.&lt;name&gt; instead of state.{stepId}.
							</span>
						</div>
						<input
							id={`${settingsIdPrefix}-as`}
							value={asText}
							disabled={spread}
							onChange={(event) => handleAsChange(event.target.value)}
							placeholder={stepId}
							spellCheck={false}
							className={cn(controlClass, "font-mono", spread && "cursor-not-allowed opacity-50")}
						/>
						{spread && (
							<span className="mt-0.5 block text-[10px] text-amber-300">
								Disabled — mutually exclusive with `spread`, which is on.
							</span>
						)}
					</div>

					<div className="text-xs">
						<div className="mb-0.5 flex items-center gap-1.5">
							<input
								type="checkbox"
								id={`${settingsIdPrefix}-spread`}
								checked={spread}
								disabled={asText.trim() !== ""}
								onChange={(event) => handleSpreadChange(event.target.checked)}
							/>
							<label htmlFor={`${settingsIdPrefix}-spread`} className="font-mono text-zinc-200">
								spread
							</label>
						</div>
						<span className="text-[10px] text-zinc-500">
							Merge this step's output keys into the state root instead of a slot. Mutually exclusive with `as`.
						</span>
						{asText.trim() !== "" && (
							<span className="mt-0.5 block text-[10px] text-amber-300">
								Disabled — mutually exclusive with `as`, which is set.
							</span>
						)}
					</div>

					<div className="text-xs">
						<div className="mb-0.5 flex items-center gap-1.5">
							<input
								type="checkbox"
								id={`${settingsIdPrefix}-ephemeral`}
								checked={ephemeral}
								onChange={(event) => setEphemeral(event.target.checked)}
							/>
							<label htmlFor={`${settingsIdPrefix}-ephemeral`} className="font-mono text-zinc-200">
								ephemeral
							</label>
						</div>
						<span className="text-[10px] text-zinc-500">Do not persist this step's output to state at all.</span>
						{ephemeral && (
							<span className="mt-0.5 block text-[10px] text-amber-300">
								Warning: downstream steps cannot read this step's handle once ephemeral is on — only ctx.prev carries
								the value, and only to the immediately next step.
							</span>
						)}
					</div>

					<div className="text-xs">
						<div className="mb-0.5 flex items-baseline gap-1.5">
							<label htmlFor={`${settingsIdPrefix}-idempotency-key`} className="font-mono text-zinc-200">
								idempotencyKey
							</label>
							<span className="text-[10px] text-zinc-500">
								Skip re-running this step on a rerun that shares this key — the cached result is reused instead.
							</span>
						</div>
						<input
							id={`${settingsIdPrefix}-idempotency-key`}
							value={idempotencyKey}
							onChange={(event) => setIdempotencyKey(event.target.value)}
							placeholder="js/ctx.request.body.requestId"
							spellCheck={false}
							className={cn(controlClass, "font-mono")}
						/>
					</div>

					<fieldset className="rounded-md border border-zinc-800 p-2">
						<legend className="px-1 text-[10px] text-zinc-500">
							retry — retry this step with capped exponential backoff on failure.
						</legend>
						<div className="grid grid-cols-2 gap-2">
							<div>
								<label
									htmlFor={`${settingsIdPrefix}-retry-max-attempts`}
									className="mb-0.5 block font-mono text-[11px] text-zinc-200"
								>
									maxAttempts
								</label>
								<input
									id={`${settingsIdPrefix}-retry-max-attempts`}
									value={maxAttemptsText}
									onChange={(event) => setMaxAttemptsText(event.target.value)}
									placeholder="1–20"
									inputMode="numeric"
									className={cn(controlClass, "font-mono")}
								/>
							</div>
							<div>
								<label
									htmlFor={`${settingsIdPrefix}-retry-factor`}
									className="mb-0.5 block font-mono text-[11px] text-zinc-200"
								>
									factor
								</label>
								<input
									id={`${settingsIdPrefix}-retry-factor`}
									value={factorText}
									onChange={(event) => setFactorText(event.target.value)}
									placeholder="2"
									inputMode="decimal"
									className={cn(controlClass, "font-mono")}
								/>
							</div>
							<div>
								<label
									htmlFor={`${settingsIdPrefix}-retry-min-timeout`}
									className="mb-0.5 block font-mono text-[11px] text-zinc-200"
								>
									minTimeoutInMs
								</label>
								<input
									id={`${settingsIdPrefix}-retry-min-timeout`}
									value={minTimeoutText}
									onChange={(event) => setMinTimeoutText(event.target.value)}
									placeholder="1000"
									inputMode="numeric"
									className={cn(controlClass, "font-mono")}
								/>
							</div>
							<div>
								<label
									htmlFor={`${settingsIdPrefix}-retry-max-timeout`}
									className="mb-0.5 block font-mono text-[11px] text-zinc-200"
								>
									maxTimeoutInMs
								</label>
								<input
									id={`${settingsIdPrefix}-retry-max-timeout`}
									value={maxTimeoutText}
									onChange={(event) => setMaxTimeoutText(event.target.value)}
									placeholder="30000"
									inputMode="numeric"
									className={cn(controlClass, "font-mono")}
								/>
							</div>
						</div>
						{settingsErrors.retry && (
							<span className="mt-1 block text-[10px] text-red-300">{settingsErrors.retry}</span>
						)}
					</fieldset>

					<div className="text-xs">
						<div className="mb-0.5 flex items-baseline gap-1.5">
							<label htmlFor={`${settingsIdPrefix}-max-duration`} className="font-mono text-zinc-200">
								maxDuration
							</label>
							<span className="text-[10px] text-zinc-500">
								Fail this attempt if it runs longer than this — pairs with `retry` for a per-attempt timeout.
							</span>
						</div>
						<input
							id={`${settingsIdPrefix}-max-duration`}
							value={maxDurationText}
							onChange={(event) => setMaxDurationText(event.target.value)}
							placeholder="30s"
							spellCheck={false}
							className={cn(controlClass, "font-mono")}
						/>
						{settingsErrors.maxDuration && (
							<span className="mt-0.5 block text-[10px] text-red-300">{settingsErrors.maxDuration}</span>
						)}
					</div>
				</div>
			) : raw ? (
				<textarea
					aria-label="Raw inputs JSON"
					value={rawText}
					onChange={(event) => setRawText(event.target.value)}
					rows={8}
					spellCheck={false}
					className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
				/>
			) : (
				<div className={cn("mt-2 grid grid-cols-1 gap-2", !narrow && "md:grid-cols-2")}>
					{fields.map((field) => {
						const controlId = `step-input-${stepId}-${field.name}`;
						const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
							setValues((current) => ({ ...current, [field.name]: event.target.value }));
						return (
							<div key={field.name} className="relative text-xs">
								<div className="mb-0.5 flex items-center gap-1.5">
									<label htmlFor={controlId} className="flex min-w-0 items-baseline gap-1.5">
										<span className="font-mono text-zinc-200">{field.name}</span>
										{field.required && <span className="text-[10px] text-amber-300">required</span>}
										{field.description && (
											<span className="truncate text-[10px] text-zinc-500" title={field.description}>
												{field.description}
											</span>
										)}
									</label>
									<button
										type="button"
										title="Insert a value from an upstream step"
										onClick={() => setPickerFor((current) => (current === field.name ? null : field.name))}
										className="ml-auto shrink-0 text-zinc-500 hover:text-blok-green-400"
									>
										<SquareFunction className="h-3.5 w-3.5" />
									</button>
								</div>
								{pickerFor === field.name && (
									<UpstreamPicker
										sources={sources}
										onPick={(expr) => insertValue(field.name, expr)}
										onClose={() => setPickerFor(null)}
									/>
								)}
								{field.kind === "enum" ? (
									<select id={controlId} value={values[field.name] ?? ""} onChange={onChange} className={controlClass}>
										<option value="">— unset —</option>
										{(field.options ?? []).map((option) => (
											<option key={String(option)} value={String(option)}>
												{String(option)}
											</option>
										))}
									</select>
								) : field.kind === "boolean" ? (
									<select id={controlId} value={values[field.name] ?? ""} onChange={onChange} className={controlClass}>
										<option value="">— unset —</option>
										<option value="true">true</option>
										<option value="false">false</option>
									</select>
								) : field.kind === "json" ? (
									<textarea
										id={controlId}
										value={values[field.name] ?? ""}
										onChange={onChange}
										rows={3}
										spellCheck={false}
										placeholder="JSON or js/ expression"
										className={cn(controlClass, "p-2 font-mono")}
									/>
								) : (
									<input
										id={controlId}
										value={values[field.name] ?? ""}
										onChange={onChange}
										spellCheck={false}
										className={cn(controlClass, "font-mono", fieldErrors[field.name] && "border-red-400/60")}
									/>
								)}
								{fieldErrors[field.name] && (
									<span className="mt-0.5 block text-[10px] text-red-300">{fieldErrors[field.name]}</span>
								)}
							</div>
						);
					})}
				</div>
			)}
		</form>
	);
}
