import { STATUS_COLORS, STATUS_DOT_COLORS, STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { NodeRunStatus, WorkflowRunStatus } from "@/types";

interface StatusBadgeProps {
	status: WorkflowRunStatus | NodeRunStatus;
	className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
				STATUS_COLORS[status],
				className,
			)}
		>
			<span
				className={cn(
					"w-1.5 h-1.5 rounded-full",
					STATUS_DOT_COLORS[status],
					status === "running" && "animate-pulse-dot",
				)}
				aria-hidden="true"
			/>
			{STATUS_LABELS[status]}
		</span>
	);
}
