import { EVENT_COLORS, EVENT_LABELS } from "@/lib/constants";
import { formatRelativeTime } from "@/lib/formatters";
import { connectGlobalStream } from "@/lib/sse";
import { cn } from "@/lib/utils";
import type { RunEvent } from "@/types";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

interface LiveFeedProps {
	maxEvents?: number;
}

export function LiveFeed({ maxEvents = 50 }: LiveFeedProps) {
	const [events, setEvents] = useState<RunEvent[]>([]);
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const disconnect = connectGlobalStream({
			onEvent: (event) => {
				setEvents((prev) => {
					const next = [event, ...prev];
					return next.length > maxEvents ? next.slice(0, maxEvents) : next;
				});
			},
		});
		return disconnect;
	}, [maxEvents]);

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
