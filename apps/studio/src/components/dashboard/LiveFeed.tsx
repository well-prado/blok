import { EVENT_COLORS, EVENT_LABELS } from "@/lib/constants";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useLiveFeedStore } from "@/stores/liveFeed";
import { Link } from "@tanstack/react-router";
import { useRef } from "react";

/**
 * Displays a live feed of recent workflow events.
 * Consumes events from the shared live feed store, which is populated
 * by the global SSE stream managed in useGlobalStream (root layout).
 * No duplicate SSE connection — single source of truth.
 */
export function LiveFeed() {
	const events = useLiveFeedStore((s) => s.events);
	const bottomRef = useRef<HTMLDivElement>(null);

	if (events.length === 0) {
		return <div className="text-center py-8 text-zinc-600 text-xs">Waiting for events...</div>;
	}

	return (
		<div className="space-y-0.5 max-h-64 overflow-y-auto">
			{events.map((event) => (
				<Link
					key={event.id}
					to="/runs/$runId"
					params={{ runId: event.runId }}
					className="flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800/50 transition-colors group"
				>
					<span
						className={cn(
							"w-1.5 h-1.5 rounded-full flex-shrink-0",
							event.type.includes("FAIL") || event.type.includes("ERROR")
								? "bg-red-400"
								: event.type.includes("COMPLETE")
									? "bg-green-400"
									: event.type.includes("START")
										? "bg-blue-400"
										: "bg-zinc-500",
							event.type.includes("RUNNING") && "animate-pulse-dot",
						)}
					/>
					<div className="flex-1 min-w-0">
						<span className="text-[11px] text-zinc-300 truncate block">{event.nodeName || event.workflowName}</span>
					</div>
					<span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0", EVENT_COLORS[event.type])}>
						{EVENT_LABELS[event.type]}
					</span>
					<span className="text-[10px] text-zinc-600 flex-shrink-0">{formatRelativeTime(event.timestamp)}</span>
				</Link>
			))}
			<div ref={bottomRef} />
		</div>
	);
}
