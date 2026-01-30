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
			<div className="flex rounded-md border border-zinc-800 overflow-hidden">
				{STATUS_OPTIONS.map((opt) => (
					<button
						type="button"
						key={opt.value}
						onClick={() => onStatusChange(opt.value)}
						className={cn(
							"px-3 py-1.5 text-xs font-medium transition-colors",
							status === opt.value
								? "bg-zinc-700 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50",
						)}
					>
						{opt.label}
					</button>
				))}
			</div>
		</div>
	);
}
