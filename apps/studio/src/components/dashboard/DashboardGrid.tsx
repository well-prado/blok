import { cn } from "@/lib/utils";
import type { DashboardWidget, MetricsResponse } from "@/types";
import { GripVertical, Settings2, X } from "lucide-react";
import { useMemo } from "react";
import { WidgetRenderer } from "./WidgetRenderer";

interface DashboardGridProps {
	widgets: DashboardWidget[];
	metrics: MetricsResponse | undefined;
	isEditing: boolean;
	onRemoveWidget: (widgetId: string) => void;
	onConfigureWidget: (widgetId: string) => void;
}

export function DashboardGrid({ widgets, metrics, isEditing, onRemoveWidget, onConfigureWidget }: DashboardGridProps) {
	// Sort widgets by position (top-to-bottom, left-to-right)
	const sortedWidgets = useMemo(
		() => [...widgets].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x),
		[widgets],
	);

	if (widgets.length === 0) {
		return (
			<div className="flex items-center justify-center h-64 text-zinc-600 text-sm border border-dashed border-zinc-800 rounded-lg">
				No widgets yet. Click &quot;Add Widget&quot; to get started.
			</div>
		);
	}

	return (
		<div className="grid grid-cols-12 gap-4 auto-rows-[120px]">
			{sortedWidgets.map((widget) => (
				<div
					key={widget.id}
					className={cn(
						"rounded-lg border bg-zinc-900/50 overflow-hidden flex flex-col",
						isEditing ? "border-blue-500/30" : "border-zinc-800",
					)}
					style={{
						gridColumn: `span ${widget.position.w}`,
						gridRow: `span ${widget.position.h}`,
					}}
				>
					{/* Widget header */}
					<div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50 shrink-0">
						<div className="flex items-center gap-1.5 min-w-0">
							{isEditing && <GripVertical className="w-3 h-3 text-zinc-600 cursor-grab shrink-0" />}
							<span className="text-xs font-medium text-zinc-400 truncate">{widget.title}</span>
						</div>
						{isEditing && (
							<div className="flex items-center gap-1 shrink-0">
								<button
									type="button"
									onClick={() => onConfigureWidget(widget.id)}
									className="p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors"
								aria-label="Configure widget"
								>
									<Settings2 className="w-3 h-3" />
								</button>
								<button
									type="button"
									onClick={() => onRemoveWidget(widget.id)}
									className="p-0.5 text-zinc-600 hover:text-red-400 transition-colors"
								aria-label="Remove widget"
								>
									<X className="w-3 h-3" />
								</button>
							</div>
						)}
					</div>
					{/* Widget content */}
					<div className="flex-1 p-3 overflow-hidden">
						<WidgetRenderer widget={widget} metrics={metrics} />
					</div>
				</div>
			))}
		</div>
	);
}
