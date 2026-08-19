import { cn } from "@/lib/utils";
import { useEnvScope } from "@/stores/envScope";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

export function EnvironmentSelector() {
	const current = useEnvScope((s) => s.current);
	const available = useEnvScope((s) => s.available);
	const setCurrent = useEnvScope((s) => s.setCurrent);
	const currentEnv = available.find((e) => e.id === current) ?? available[0];

	if (!currentEnv) return null;

	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-raised px-2 py-1.5 text-xs text-zinc-100 hover:bg-hover transition-colors data-[state=open]:bg-hover"
					aria-label={`Environment: ${currentEnv.name}`}
				>
					<div className="flex items-center gap-2">
						<span
							className="h-1.5 w-1.5 rounded-full bg-blok-green-500"
							style={{ boxShadow: "0 0 0 2px rgba(43, 205, 113, 0.18)" }}
						/>
						<span className="font-medium">{currentEnv.name}</span>
					</div>
					<ChevronDown className="w-3.5 h-3.5 text-zinc-500 transition-transform data-[state=open]:rotate-180" />
				</button>
			</DropdownMenu.Trigger>

			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={4}
					className="z-50 w-56 rounded-md border border-zinc-800 bg-overlay shadow-xl py-1 overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
				>
					<div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold">
						Environment
					</div>
					<DropdownMenu.RadioGroup value={current} onValueChange={setCurrent}>
						{available.map((env) => {
							const selected = env.id === current;
							return (
								<DropdownMenu.RadioItem
									key={env.id}
									value={env.id}
									className={cn(
										"relative flex w-full cursor-default select-none items-center gap-2 px-3 py-1.5 text-xs outline-none transition-colors",
										selected
											? "bg-blok-green-500/10 text-zinc-100"
											: "text-zinc-300 focus:bg-hover focus:text-zinc-100",
									)}
								>
									<span
										className={cn("h-1.5 w-1.5 rounded-full shrink-0", selected ? "bg-blok-green-500" : "bg-zinc-700")}
										style={selected ? { boxShadow: "0 0 0 2px rgba(43, 205, 113, 0.18)" } : undefined}
									/>
									<span className="font-medium">{env.name}</span>
									{env.description && <span className="text-[11px] text-zinc-500 truncate">· {env.description}</span>}
									{selected && <Check className="ml-auto w-3.5 h-3.5 text-blok-green-500 shrink-0" />}
								</DropdownMenu.RadioItem>
							);
						})}
					</DropdownMenu.RadioGroup>
					<div className="mt-1 px-3 py-1.5 text-[10.5px] font-mono text-zinc-600 border-t border-zinc-800">
						Set <span className="text-zinc-400">BLOK_ENV</span> on the trigger to scope new runs.
					</div>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
