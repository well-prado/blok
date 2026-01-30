import { useState } from "react";
import { Plus, X, BarChart3, TrendingUp, Activity, Clock, Layers, Cpu, List, Grid3X3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardWidget, WidgetType } from "@/types";

interface AddWidgetDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (widget: DashboardWidget) => void;
}

const WIDGET_TEMPLATES: Array<{
  type: WidgetType;
  title: string;
  description: string;
  icon: React.ReactNode;
  defaultConfig: DashboardWidget["config"];
  defaultSize: { w: number; h: number };
}> = [
  {
    type: "stat-card",
    title: "Stat Card",
    description: "A single key metric value",
    icon: <TrendingUp className="w-5 h-5" />,
    defaultConfig: { metric: "totalRuns" },
    defaultSize: { w: 3, h: 1 },
  },
  {
    type: "timeline",
    title: "Execution Timeline",
    description: "Hourly execution bar chart (24h)",
    icon: <BarChart3 className="w-5 h-5" />,
    defaultConfig: { timeRange: "24h" },
    defaultSize: { w: 6, h: 2 },
  },
  {
    type: "error-rate",
    title: "Error Rate",
    description: "Overall error rate gauge",
    icon: <Activity className="w-5 h-5" />,
    defaultConfig: {},
    defaultSize: { w: 3, h: 2 },
  },
  {
    type: "duration-distribution",
    title: "Duration Distribution",
    description: "Histogram of execution durations",
    icon: <Clock className="w-5 h-5" />,
    defaultConfig: {},
    defaultSize: { w: 6, h: 2 },
  },
  {
    type: "workflow-breakdown",
    title: "Workflow Breakdown",
    description: "Runs per workflow with error rates",
    icon: <Layers className="w-5 h-5" />,
    defaultConfig: {},
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: "node-performance",
    title: "Node Performance",
    description: "Average durations per node",
    icon: <Cpu className="w-5 h-5" />,
    defaultConfig: {},
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: "recent-runs",
    title: "Recent Runs",
    description: "Summary of recent run outcomes",
    icon: <List className="w-5 h-5" />,
    defaultConfig: {},
    defaultSize: { w: 4, h: 2 },
  },
  {
    type: "heatmap",
    title: "Activity Heatmap",
    description: "24-hour execution activity heatmap",
    icon: <Grid3X3 className="w-5 h-5" />,
    defaultConfig: {},
    defaultSize: { w: 6, h: 2 },
  },
];

const STAT_METRICS = [
  { value: "totalRuns", label: "Total Runs" },
  { value: "completedRuns", label: "Completed Runs" },
  { value: "failedRuns", label: "Failed Runs" },
  { value: "errorRate", label: "Error Rate" },
  { value: "avgDurationMs", label: "Avg Duration" },
  { value: "p50DurationMs", label: "P50 Duration" },
  { value: "p95DurationMs", label: "P95 Duration" },
  { value: "p99DurationMs", label: "P99 Duration" },
];

export function AddWidgetDialog({ open, onClose, onAdd }: AddWidgetDialogProps) {
  const [selectedType, setSelectedType] = useState<WidgetType | null>(null);
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState("totalRuns");

  if (!open) return null;

  const template = WIDGET_TEMPLATES.find((t) => t.type === selectedType);

  const handleAdd = () => {
    if (!template) return;

    const widget: DashboardWidget = {
      id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: template.type,
      title: title || template.title,
      config: {
        ...template.defaultConfig,
        ...(template.type === "stat-card" ? { metric } : {}),
      },
      position: {
        x: 0,
        y: 100, // Will be placed at bottom
        w: template.defaultSize.w,
        h: template.defaultSize.h,
      },
    };

    onAdd(widget);
    setSelectedType(null);
    setTitle("");
    setMetric("totalRuns");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg bg-zinc-900 rounded-lg border border-zinc-800 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Add Widget</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {!selectedType ? (
            /* Widget type selection */
            <div className="grid grid-cols-2 gap-2">
              {WIDGET_TEMPLATES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  onClick={() => {
                    setSelectedType(t.type);
                    setTitle(t.title);
                  }}
                  className="flex items-start gap-3 p-3 rounded-md border border-zinc-800 hover:border-blue-500/50 hover:bg-zinc-800/50 transition-colors text-left"
                >
                  <div className="text-zinc-500 mt-0.5">{t.icon}</div>
                  <div>
                    <div className="text-sm font-medium text-zinc-200">{t.title}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{t.description}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            /* Widget configuration */
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => setSelectedType(null)}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                ← Back to widget types
              </button>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 outline-none focus:border-blue-500"
                  placeholder={template?.title}
                />
              </div>

              {selectedType === "stat-card" && (
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">
                    Metric
                  </label>
                  <select
                    value={metric}
                    onChange={(e) => setMetric(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 outline-none focus:border-blue-500"
                  >
                    {STAT_METRICS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {selectedType && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                "bg-blue-600 text-white hover:bg-blue-500",
              )}
            >
              <Plus className="w-3 h-3" />
              Add Widget
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
