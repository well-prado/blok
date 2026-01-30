import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { EVENT_COLORS, EVENT_LABELS } from "@/lib/constants";
import { formatTimestamp } from "@/lib/formatters";
import { fetchRunEvents } from "@/lib/api";

interface EventLogProps {
  runId: string;
}

export function EventLog({ runId }: EventLogProps) {
  const { data: events, isLoading } = useQuery({
    queryKey: ["run-events", runId],
    queryFn: () => fetchRunEvents(runId),
    refetchInterval: 3000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-600 text-xs">No events recorded</div>
    );
  }

  return (
    <div className="space-y-0.5 font-mono text-xs">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/30 rounded"
        >
          <span className="text-[10px] text-zinc-600 flex-shrink-0 w-20">
            {formatTimestamp(event.timestamp).split(", ")[1]}
          </span>
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0",
              EVENT_COLORS[event.type],
            )}
          >
            {EVENT_LABELS[event.type]}
          </span>
          {event.nodeName && (
            <span className="text-zinc-400 flex-shrink-0">{event.nodeName}</span>
          )}
          <span className="text-zinc-600 truncate flex-1">
            {event.workflowName}
          </span>
          <span className="text-[10px] text-zinc-700 flex-shrink-0">
            {event.id.slice(0, 8)}
          </span>
        </div>
      ))}
    </div>
  );
}
