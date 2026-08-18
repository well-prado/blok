import type { FilterFieldDef } from "@/lib/filterTypes";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface AppliedFilterChipProps {
	field: FilterFieldDef;
	value: string;
	onRemove: () => void;
	onClick?: () => void;
	className?: string;
}

export function AppliedFilterChip({ field, value, onRemove, onClick, className }: AppliedFilterChipProps) {
	return (
		<div
			className={cn(
				"inline-flex items-center rounded-full bg-control border border-line",
				"text-xs font-medium text-zinc-100 h-6 overflow-hidden",
				className,
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className="flex items-center px-2 py-0.5 hover:bg-hover transition-colors h-full focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
				aria-label={`Edit ${field.label} filter`}
			>
				{field.icon && <span className="mr-1.5 opacity-70">{field.icon}</span>}
				<span className="text-zinc-400 mr-1">{field.label}:</span>
				<span>{value}</span>
			</button>
			<button
				type="button"
				onClick={onRemove}
				className="flex items-center justify-center px-1.5 h-full hover:bg-hover hover:text-status-failed-ink transition-colors border-l border-line focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
				aria-label={`Remove ${field.label} filter`}
			>
				<X size={12} strokeWidth={2.5} />
			</button>
		</div>
	);
}
