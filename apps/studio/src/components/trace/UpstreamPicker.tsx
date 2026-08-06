import { stripJsPrefix } from "@/lib/branchCondition";
import type { UpstreamSource } from "@/lib/upstreamSources";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface UpstreamPickerProps {
	sources: UpstreamSource[];
	onPick: (expr: string) => void;
	onClose: () => void;
	/**
	 * Step inputs use the `js/` mapper prefix (see upstreamSources.ts), but a
	 * branch condition is evaluated as raw JS (ADR 0004) — `raw: true` strips
	 * that prefix before calling `onPick` so a picked expression can never leak
	 * `js/` into a `when` string.
	 */
	raw?: boolean;
}

/**
 * The n8n/BuildShip-style handle picker (Phase 5.3): trigger + every
 * upstream step, expandable to their output fields. A field click writes
 * its expr into the field; a source-row click writes the whole-output expr.
 * No portal — absolutely positioned inside the field's `relative` wrapper,
 * closed on outside click or Escape.
 */
export function UpstreamPicker({ sources, onPick, onClose, raw }: UpstreamPickerProps) {
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

	const pick = (expr: string) => onPick(raw ? stripJsPrefix(expr) : expr);

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
								onClick={() => pick(source.expr)}
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
										onClick={() => pick(field.expr)}
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
