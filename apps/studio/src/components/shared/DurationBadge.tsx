import { useState, useEffect } from "react";
import { Clock } from "lucide-react";
import { formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface DurationBadgeProps {
  ms: number | undefined;
  running?: boolean;
  className?: string;
}

export function DurationBadge({ ms, running, className }: DurationBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-mono",
        running ? "text-blue-400" : "text-zinc-400",
        className,
      )}
    >
      <Clock className="w-3 h-3" />
      {running ? <ElapsedTimer startedAt={ms || Date.now()} /> : formatDuration(ms)}
    </span>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startedAt);

  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(interval);
  }, [startedAt]);

  return <>{formatDuration(elapsed)}</>;
}
