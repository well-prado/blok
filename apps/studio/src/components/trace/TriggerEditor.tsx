import { cn } from "@/lib/utils";
import { Loader2, X, Zap } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Phase 5 — trigger editor drawer, modeled on atomic-canvas's TriggerForm
 * (right drawer, Configuration tab, kind select + per-kind fields, Save).
 * Common kinds get typed fields; everything else — and full fidelity for
 * scheduling knobs, middleware arrays, etc. — lives in the Raw JSON view.
 * The definition save runs the runner's normalizer, so an invalid trigger
 * never reaches disk. Route BINDINGS (e.g. a new http path) refresh on the
 * next boot; Studio test runs pick the new trigger up immediately.
 */

export const TRIGGER_KINDS = [
	"http",
	"cron",
	"worker",
	"manual",
	"webhook",
	"pubsub",
	"sse",
	"websocket",
	"grpc",
	"mcp",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

interface TriggerField {
	name: string;
	kind: "text" | "select" | "boolean";
	options?: string[];
	placeholder?: string;
	hint?: string;
}

/** Typed fields for the common kinds; other kinds edit as raw JSON. */
const TRIGGER_FIELDS: Partial<Record<TriggerKind, TriggerField[]>> = {
	http: [
		{
			name: "method",
			kind: "select",
			options: ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"],
		},
		{ name: "path", kind: "text", placeholder: "/orders/:id" },
		{ name: "accept", kind: "text", placeholder: "application/json" },
	],
	cron: [
		{ name: "schedule", kind: "text", placeholder: "0 * * * *", hint: "cron expression" },
		{ name: "timezone", kind: "text", placeholder: "UTC" },
		{ name: "overlap", kind: "boolean", hint: "allow overlapping executions" },
	],
	worker: [
		{ name: "queue", kind: "text", placeholder: "orders" },
		{ name: "provider", kind: "text", placeholder: "in-memory | bullmq | kafka | …" },
		{ name: "concurrency", kind: "text", placeholder: "1" },
	],
	manual: [],
};

export interface TriggerEditorProps {
	/** The workflow's current `trigger` object, e.g. { http: { method, path } }. */
	trigger: Record<string, unknown>;
	pending: boolean;
	error?: string;
	onSave: (trigger: Record<string, unknown>) => void;
	onClose: () => void;
}

function currentKind(trigger: Record<string, unknown>): TriggerKind {
	const key = Object.keys(trigger)[0];
	return (TRIGGER_KINDS as readonly string[]).includes(key ?? "") ? (key as TriggerKind) : "http";
}

export function TriggerEditor({ trigger, pending, error, onSave, onClose }: TriggerEditorProps) {
	const initialKind = useMemo(() => currentKind(trigger), [trigger]);
	const [kind, setKind] = useState<TriggerKind>(initialKind);
	const fields = TRIGGER_FIELDS[kind];
	const [raw, setRaw] = useState(fields === undefined);
	const [rawText, setRawText] = useState(() => JSON.stringify(trigger, null, 2));
	const [values, setValues] = useState<Record<string, string>>(() => {
		const config = (trigger[initialKind] ?? {}) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(config).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
		);
	});
	const [formError, setFormError] = useState<string>();

	const pickKind = (next: TriggerKind) => {
		setKind(next);
		setFormError(undefined);
		if (TRIGGER_FIELDS[next] === undefined) {
			setRaw(true);
			setRawText(JSON.stringify(next === initialKind ? trigger : { [next]: {} }, null, 2));
		} else {
			setRaw(false);
			const config = (next === initialKind ? (trigger[initialKind] as Record<string, unknown>) : {}) ?? {};
			setValues(
				Object.fromEntries(
					Object.entries(config).map(([key, value]) => [
						key,
						typeof value === "string" ? value : JSON.stringify(value),
					]),
				),
			);
		}
	};

	const submit = () => {
		if (raw) {
			try {
				const parsed = JSON.parse(rawText || "{}");
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
				onSave(parsed as Record<string, unknown>);
			} catch (parseError) {
				setFormError(`Invalid JSON: ${(parseError as Error).message}`);
			}
			return;
		}
		const config: Record<string, unknown> = {};
		// Preserve knobs the form doesn't render (middleware, delay, examples…).
		if (kind === initialKind && typeof trigger[initialKind] === "object" && trigger[initialKind] !== null) {
			for (const [key, value] of Object.entries(trigger[initialKind] as Record<string, unknown>)) {
				if (!(fields ?? []).some((field) => field.name === key)) config[key] = value;
			}
		}
		for (const field of fields ?? []) {
			const text = (values[field.name] ?? "").trim();
			if (text === "") continue;
			if (field.kind === "boolean") config[field.name] = text === "true";
			else if (/^\d+$/.test(text)) config[field.name] = Number(text);
			else config[field.name] = text;
		}
		setFormError(undefined);
		onSave({ [kind]: config });
	};

	return (
		<div className="flex h-full w-80 shrink-0 flex-col border-l border-zinc-800 bg-[#131316]">
			<div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
				<span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15">
					<Zap className="h-3.5 w-3.5 text-emerald-400" />
				</span>
				<span className="text-sm font-semibold text-zinc-100">Trigger</span>
				<button
					type="button"
					onClick={() => setRaw((current) => !current)}
					className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					{raw ? "Form" : "Raw JSON"}
				</button>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close trigger editor"
					className="ml-auto rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
			<form
				aria-label="Trigger configuration"
				className="flex min-h-0 flex-1 flex-col"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
					{!raw && (
						<>
							<label className="block text-xs">
								<span className="mb-0.5 block text-[10px] text-zinc-400">Type</span>
								<select
									value={kind}
									onChange={(event) => pickKind(event.target.value as TriggerKind)}
									className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
								>
									{TRIGGER_KINDS.map((option) => (
										<option key={option} value={option}>
											{option}
										</option>
									))}
								</select>
							</label>
							{(fields ?? []).map((field) => {
								const controlId = `trigger-field-${field.name}`;
								const controlClass =
									"w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400";
								const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
									setValues((current) => ({ ...current, [field.name]: event.target.value }));
								return (
									<div key={field.name} className="text-xs">
										<label htmlFor={controlId} className="mb-0.5 flex items-baseline gap-1.5">
											<span className="font-mono text-[11px] text-zinc-200">{field.name}</span>
											{field.hint && <span className="text-[10px] text-zinc-500">{field.hint}</span>}
										</label>
										{field.kind === "select" ? (
											<select
												id={controlId}
												value={values[field.name] ?? ""}
												onChange={onChange}
												className={controlClass}
											>
												<option value="">— unset —</option>
												{(field.options ?? []).map((option) => (
													<option key={option} value={option}>
														{option}
													</option>
												))}
											</select>
										) : field.kind === "boolean" ? (
											<select
												id={controlId}
												value={values[field.name] ?? ""}
												onChange={onChange}
												className={controlClass}
											>
												<option value="">— unset —</option>
												<option value="true">true</option>
												<option value="false">false</option>
											</select>
										) : (
											<input
												id={controlId}
												value={values[field.name] ?? ""}
												onChange={onChange}
												placeholder={field.placeholder}
												spellCheck={false}
												className={cn(controlClass, "font-mono")}
											/>
										)}
									</div>
								);
							})}
							{fields !== undefined && kind === "manual" && (
								<p className="text-[10px] text-zinc-500">Manual triggers have no configuration — dispatch from code.</p>
							)}
						</>
					)}
					{raw && (
						<textarea
							aria-label="Raw trigger JSON"
							value={rawText}
							onChange={(event) => setRawText(event.target.value)}
							rows={14}
							spellCheck={false}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
						/>
					)}
					{(formError || error) && <p className="text-xs text-red-300">{formError || error}</p>}
					<p className="text-[10px] text-zinc-500">
						Studio runs use the new trigger immediately; HTTP route bindings refresh on the next boot.
					</p>
				</div>
				<div className="border-t border-zinc-800 p-3">
					<button
						type="submit"
						disabled={pending}
						className={cn(
							"inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-blok-green-500 px-3 py-1.5 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600",
							"disabled:cursor-not-allowed disabled:opacity-40",
						)}
					>
						{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save trigger
					</button>
				</div>
			</form>
		</div>
	);
}
