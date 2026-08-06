import type { NodeCatalogEntry } from "@/lib/api";
import { type UpstreamSource, upstreamSources } from "@/lib/upstreamSources";
import { cn } from "@/lib/utils";
import type { NodeRun } from "@/types";
import { ChevronRight, Loader2, SquareFunction } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Phase 5.3 — schema-driven step-inputs editor. Renders a form from the
 * node's reflected JSON Schema (the catalog's `inputSchema`), following
 * atomic-canvas's DrawerConfig/groupProperties model flattened to one level:
 * top-level primitives get typed fields, everything else (objects, arrays,
 * unions) gets a per-field JSON textarea. Any string field may hold a
 * `js/...` expression — the runner's mapper resolves it at run time.
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

	const insertValue = (fieldName: string, expr: string) => {
		setValues((current) => ({ ...current, [fieldName]: expr }));
		setPickerFor(null);
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

	return (
		<form
			aria-label={`Inputs for ${stepId}`}
			className={cn(
				"bg-zinc-950/70 px-3 py-2",
				narrow ? "flex min-h-0 flex-1 flex-col overflow-y-auto" : "border-b border-zinc-800",
			)}
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className={cn("flex items-center gap-2", narrow && "flex-wrap")}>
				<span className="text-xs font-medium text-zinc-300">
					Inputs for <span className="font-mono">{stepId}</span>
				</span>
				<button
					type="button"
					onClick={() => setRaw((current) => !current)}
					className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					{raw ? "Form" : "Raw JSON"}
				</button>
				<span className="text-[10px] text-zinc-500">Values starting with js/ are evaluated at run time.</span>
				<button
					type="submit"
					disabled={pending}
					className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-2.5 py-1 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save inputs
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
			{fieldErrors.__raw && <p className="mt-2 text-xs text-red-300">{fieldErrors.__raw}</p>}
			{raw ? (
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
						const controlClass =
							"w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400";
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

/** Truncated one-line JSON preview for a sample value (~40 chars). */
function previewSample(sample: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(sample) ?? String(sample);
	} catch {
		text = String(sample);
	}
	return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

interface UpstreamPickerProps {
	sources: UpstreamSource[];
	onPick: (expr: string) => void;
	onClose: () => void;
}

/**
 * The n8n/BuildShip-style handle picker (Phase 5.3): trigger + every
 * upstream step, expandable to their output fields. A field click writes
 * its `js/ctx.state...` expr into the field; a source-row click writes the
 * whole-output expr. No portal — absolutely positioned inside the field's
 * `relative` wrapper, closed on outside click or Escape.
 */
function UpstreamPicker({ sources, onPick, onClose }: UpstreamPickerProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onPointerDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mousedown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mousedown", onPointerDown);
		};
	}, [onClose]);

	const toggle = (id: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		// `menu`, not `listbox` — click-to-dispatch (inserts an expression and
		// closes) rather than a `<select>`-style persisted selection. Mirrors
		// the same choice in EnvChip.
		<div
			ref={ref}
			role="menu"
			aria-label="Insert a value from an upstream step"
			className="absolute right-0 top-full z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 p-1 text-left shadow-xl shadow-black/40"
		>
			{sources.length === 0 && <p className="px-2 py-1 text-[10px] text-zinc-500">No upstream sources</p>}
			{sources.map((source) => {
				const isOpen = expanded.has(source.id);
				return (
					<div key={source.id}>
						<div className="flex items-center gap-1 rounded hover:bg-zinc-800">
							<button
								type="button"
								onClick={() => toggle(source.id)}
								aria-label={isOpen ? `Collapse ${source.id}` : `Expand ${source.id}`}
								className="p-1 text-zinc-500"
							>
								<ChevronRight className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")} />
							</button>
							<button
								type="button"
								onClick={() => onPick(source.expr)}
								className="flex-1 truncate py-1 pr-1 text-left text-[11px] text-zinc-200"
							>
								{source.id}
								{source.ref && (
									<>
										{" · "}
										<span className="ml-1.5 text-[10px] text-zinc-500">{source.ref}</span>
									</>
								)}
							</button>
						</div>
						{isOpen && (
							<div className="ml-4 border-l border-zinc-800 pl-2">
								{source.fields.length === 0 && <p className="px-1 py-0.5 text-[10px] text-zinc-600">no known fields</p>}
								{source.fields.map((field) => (
									<button
										key={field.path}
										type="button"
										onClick={() => onPick(field.expr)}
										className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-zinc-800"
									>
										<span className="font-mono text-[11px] text-zinc-200">{field.path}</span>
										{field.type && (
											<>
												{" · "}
												<span className="text-[10px] text-zinc-500">{field.type}</span>
											</>
										)}
										{field.sample !== undefined && (
											<>
												{" · "}
												<span className="truncate text-[10px] text-zinc-600">{previewSample(field.sample)}</span>
											</>
										)}
									</button>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
