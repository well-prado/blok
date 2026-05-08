import { cn } from "@/lib/utils";
import { useEnvScope } from "@/stores/envScope";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Environment chip — Direction A's "envs are first-class" pattern.
 *
 * Now wired: clicking opens a popover with available environments
 * (production / staging / development by default; Phase 2.1 backend
 * work will replace the hardcoded list with a fetch from
 * `/__blok/environments`). Selection persists to localStorage via
 * `useEnvScope`, so refreshing keeps the operator in their chosen
 * env. Backend filtering of `/runs?env=...` is still pending — that's
 * Phase 2.1 — but the wiring is here so wiring it up backend-side is
 * a one-branch change in `lib/api.ts`.
 *
 * Per brand-spec, the brand-green dot with the soft halo is the only
 * place the brand color *moves* (via the `animate-pulse-dot`
 * keyframe) inside the always-visible chrome. Keeps the signal rare.
 */
export function EnvChip() {
	const current = useEnvScope((s) => s.current);
	const available = useEnvScope((s) => s.available);
	const setCurrent = useEnvScope((s) => s.setCurrent);
	const currentEnv = available.find((e) => e.id === current) ?? available[0];
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onOutside = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onOutside);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onOutside);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!currentEnv) return null;

	return (
		<div ref={wrapRef} className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex items-center gap-1.5 rounded-md border border-zinc-800 bg-raised px-2 py-1 text-xs text-zinc-100 hover:bg-hover transition-colors",
					open && "bg-hover",
				)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`Environment: ${currentEnv.name}`}
			>
				<span
					className="h-1.5 w-1.5 rounded-full bg-blok-green-500"
					style={{ boxShadow: "0 0 0 2px rgba(43, 205, 113, 0.18)" }}
				/>
				<span className="font-medium">{currentEnv.name}</span>
				<ChevronDown className={cn("w-3 h-3 text-zinc-500 transition-transform", open && "rotate-180")} />
			</button>

			{open && (
				// Action-trigger dropdown — `menu` + `menuitemradio` is the
				// correct semantic for "click to choose, then dispatch",
				// not `listbox` (which expects `<select>`-style selection
				// inside a form). MDN ARIA practices §3.18.
				<div
					role="menu"
					aria-label="Environment"
					className="absolute left-0 top-full mt-1.5 z-50 w-56 rounded-md border border-zinc-800 bg-overlay shadow-xl py-1"
				>
					<div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold">
						Environment
					</div>
					{available.map((env) => {
						const selected = env.id === current;
						return (
							<button
								key={env.id}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								onClick={() => {
									setCurrent(env.id);
									setOpen(false);
								}}
								className={cn(
									"w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors",
									selected ? "bg-blok-green-500/10 text-zinc-100" : "text-zinc-300 hover:bg-hover hover:text-zinc-100",
								)}
							>
								<span
									className={cn("h-1.5 w-1.5 rounded-full shrink-0", selected ? "bg-blok-green-500" : "bg-zinc-700")}
									style={selected ? { boxShadow: "0 0 0 2px rgba(43, 205, 113, 0.18)" } : undefined}
								/>
								<span className="font-medium">{env.name}</span>
								{env.description && <span className="text-[11px] text-zinc-500 truncate">· {env.description}</span>}
								{selected && <Check className="ml-auto w-3.5 h-3.5 text-blok-green-500 shrink-0" />}
							</button>
						);
					})}
					<div className="mt-1 px-3 py-1.5 text-[10.5px] font-mono text-zinc-600 border-t border-zinc-800">
						Set <span className="text-zinc-400">BLOK_ENV</span> on the trigger to scope new runs.
					</div>
				</div>
			)}
		</div>
	);
}
