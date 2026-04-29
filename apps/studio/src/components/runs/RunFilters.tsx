import { cn } from "@/lib/utils";

interface RunFiltersProps {
	status: string;
	onStatusChange: (status: string) => void;
	className?: string;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
	{ value: "", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "completed", label: "Completed" },
	{ value: "failed", label: "Failed" },
];

export function RunFilters({ status, onStatusChange, className }: RunFiltersProps) {
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 font-semibold mr-1">Status</span>
			<div className="flex rounded-md border border-zinc-800 overflow-hidden bg-canvas">
				{STATUS_OPTIONS.map((opt) => (
					<button
						type="button"
						key={opt.value}
						onClick={() => onStatusChange(opt.value)}
						className={cn(
							"px-3 py-1.5 text-xs font-medium transition-colors border-r border-zinc-800 last:border-r-0",
							status === opt.value
								? "bg-blok-green-500/10 text-blok-green-500"
								: "text-zinc-400 hover:text-zinc-100 hover:bg-hover",
						)}
					>
						{opt.label}
					</button>
				))}
			</div>
		</div>
	);
}
