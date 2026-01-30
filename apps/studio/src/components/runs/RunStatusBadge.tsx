import { StatusBadge } from "@/components/shared/StatusBadge";
import type { WorkflowRunStatus } from "@/types";

interface RunStatusBadgeProps {
  status: WorkflowRunStatus;
  className?: string;
}

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  return <StatusBadge status={status} className={className} />;
}
