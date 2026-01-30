import { AddWidgetDialog } from "@/components/dashboard/AddWidgetDialog";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { EmptyState } from "@/components/shared/EmptyState";
import {
	useCreateDashboard,
	useDashboards,
	useDeleteDashboard,
	useDuplicateDashboard,
	useUpdateDashboard,
} from "@/hooks/useDashboards";
import { useMetrics } from "@/hooks/useMetrics";
import { cn } from "@/lib/utils";
import type { DashboardWidget } from "@/types";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, LayoutGrid, Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export const Route = createFileRoute("/dashboards")({
	component: DashboardsPage,
});

// Default dashboard template
const DEFAULT_WIDGETS: DashboardWidget[] = [
	{
		id: "w_default_1",
		type: "stat-card",
		title: "Total Runs",
		config: { metric: "totalRuns" },
		position: { x: 0, y: 0, w: 3, h: 1 },
	},
	{
		id: "w_default_2",
		type: "stat-card",
		title: "Completed",
		config: { metric: "completedRuns" },
		position: { x: 3, y: 0, w: 3, h: 1 },
	},
	{
		id: "w_default_3",
		type: "stat-card",
		title: "Failed",
		config: { metric: "failedRuns" },
		position: { x: 6, y: 0, w: 3, h: 1 },
	},
	{
		id: "w_default_4",
		type: "stat-card",
		title: "Error Rate",
		config: { metric: "errorRate" },
		position: { x: 9, y: 0, w: 3, h: 1 },
	},
	{
		id: "w_default_5",
		type: "timeline",
		title: "Execution Timeline (24h)",
		config: { timeRange: "24h" },
		position: { x: 0, y: 1, w: 6, h: 2 },
	},
	{
		id: "w_default_6",
		type: "error-rate",
		title: "Error Rate",
		config: {},
		position: { x: 6, y: 1, w: 3, h: 2 },
	},
	{
		id: "w_default_7",
		type: "recent-runs",
		title: "Run Summary",
		config: {},
		position: { x: 9, y: 1, w: 3, h: 2 },
	},
	{
		id: "w_default_8",
		type: "duration-distribution",
		title: "Duration Distribution",
		config: {},
		position: { x: 0, y: 3, w: 6, h: 2 },
	},
	{
		id: "w_default_9",
		type: "heatmap",
		title: "Activity Heatmap",
		config: {},
		position: { x: 6, y: 3, w: 6, h: 2 },
	},
];

function DashboardsPage() {
	const { data: dashboards, isLoading } = useDashboards();
	const { data: metrics, isLoading: metricsLoading } = useMetrics();
	const createDashboard = useCreateDashboard();
	const updateDashboard = useUpdateDashboard();
	const deleteDashboard = useDeleteDashboard();
	const duplicateDashboard = useDuplicateDashboard();

	const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [showAddWidget, setShowAddWidget] = useState(false);
	const [showMenu, setShowMenu] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	// Resolve active dashboard
	const activeDashboard =
		dashboards?.find((d) => d.id === activeDashboardId) ||
		dashboards?.find((d) => d.isDefault) ||
		dashboards?.[0] ||
		null;

	// Auto-select first dashboard when loaded
	useEffect(() => {
		if (dashboards && dashboards.length > 0 && !activeDashboardId) {
			const target = dashboards.find((d) => d.isDefault) ?? dashboards[0];
			if (target) setActiveDashboardId(target.id);
		}
	}, [dashboards, activeDashboardId]);

	const handleCreateDashboard = useCallback(() => {
		createDashboard.mutate(
			{ name: "New Dashboard", widgets: DEFAULT_WIDGETS },
			{
				onSuccess: (created) => {
					setActiveDashboardId(created.id);
				},
			},
		);
	}, [createDashboard]);

	const handleAddWidget = useCallback(
		(widget: DashboardWidget) => {
			if (!activeDashboard) return;
			const updated = [...activeDashboard.widgets, widget];
			updateDashboard.mutate({
				id: activeDashboard.id,
				data: { widgets: updated },
			});
		},
		[activeDashboard, updateDashboard],
	);

	const handleRemoveWidget = useCallback(
		(widgetId: string) => {
			if (!activeDashboard) return;
			const updated = activeDashboard.widgets.filter((w) => w.id !== widgetId);
			updateDashboard.mutate({
				id: activeDashboard.id,
				data: { widgets: updated },
			});
		},
		[activeDashboard, updateDashboard],
	);

	const handleConfigureWidget = useCallback((_widgetId: string) => {
		// Widget configuration is handled via the AddWidgetDialog for now
		// Future: open a config panel for the specific widget
	}, []);

	const handleDeleteDashboard = useCallback(
		(id: string) => {
			deleteDashboard.mutate(id, {
				onSuccess: () => {
					if (activeDashboardId === id) {
						setActiveDashboardId(null);
					}
					setShowMenu(null);
				},
			});
		},
		[deleteDashboard, activeDashboardId],
	);

	const handleDuplicate = useCallback(
		(id: string) => {
			duplicateDashboard.mutate(id, {
				onSuccess: (copy) => {
					setActiveDashboardId(copy.id);
					setShowMenu(null);
				},
			});
		},
		[duplicateDashboard],
	);

	const handleRename = useCallback(
		(id: string) => {
			if (!renameValue.trim()) return;
			updateDashboard.mutate(
				{ id, data: { name: renameValue.trim() } },
				{
					onSuccess: () => setRenaming(null),
				},
			);
		},
		[updateDashboard, renameValue],
	);

	if (isLoading || metricsLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
			</div>
		);
	}

	if (!dashboards || dashboards.length === 0) {
		return (
			<div className="p-6 flex flex-col items-center">
				<EmptyState
					icon={<LayoutGrid className="w-12 h-12" />}
					title="No dashboards yet"
					description="Create your first custom dashboard to visualize workflow metrics."
				/>
				<button
					type="button"
					onClick={handleCreateDashboard}
					className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
				>
					<Plus className="w-4 h-4" />
					Create Dashboard
				</button>
			</div>
		);
	}

	return (
		<div className="h-full flex flex-col">
			{/* Header bar */}
			<div className="shrink-0 border-b border-zinc-800 bg-zinc-950/50 px-4 py-3">
				<div className="flex items-center gap-3">
					<h1 className="text-sm font-semibold text-zinc-100">Dashboards</h1>

					{/* Dashboard tabs */}
					<div className="flex items-center gap-1 ml-4">
						{dashboards.map((d) => (
							<div key={d.id} className="relative flex items-center">
								{renaming === d.id ? (
									<form
										onSubmit={(e) => {
											e.preventDefault();
											handleRename(d.id);
										}}
										className="flex items-center gap-1"
									>
										<input
											type="text"
											value={renameValue}
											onChange={(e) => setRenameValue(e.target.value)}
											className="px-2 py-0.5 text-xs bg-zinc-800 border border-blue-500 rounded text-zinc-200 outline-none w-32"
											onBlur={() => setRenaming(null)}
										/>
									</form>
								) : (
									<button
										type="button"
										onClick={() => setActiveDashboardId(d.id)}
										className={cn(
											"px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
											d.id === activeDashboard?.id
												? "bg-zinc-800 text-zinc-100"
												: "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50",
										)}
									>
										{d.name}
									</button>
								)}

								{/* Context menu trigger */}
								{d.id === activeDashboard?.id && (
									<div className="relative">
										<button
											type="button"
											onClick={() => setShowMenu(showMenu === d.id ? null : d.id)}
											className="p-0.5 text-zinc-600 hover:text-zinc-300 ml-0.5"
										>
											<MoreHorizontal className="w-3.5 h-3.5" />
										</button>

										{/* Dropdown menu */}
										{showMenu === d.id && (
											<div className="absolute top-full left-0 mt-1 w-40 bg-zinc-900 border border-zinc-800 rounded-md shadow-lg z-50 py-1">
												<button
													type="button"
													onClick={() => {
														setRenaming(d.id);
														setRenameValue(d.name);
														setShowMenu(null);
													}}
													className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
												>
													<Pencil className="w-3 h-3" /> Rename
												</button>
												<button
													type="button"
													onClick={() => handleDuplicate(d.id)}
													className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
												>
													<Copy className="w-3 h-3" /> Duplicate
												</button>
												<button
													type="button"
													onClick={() => handleDeleteDashboard(d.id)}
													className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-800"
												>
													<Trash2 className="w-3 h-3" /> Delete
												</button>
											</div>
										)}
									</div>
								)}
							</div>
						))}

						{/* New dashboard button */}
						<button
							type="button"
							onClick={handleCreateDashboard}
							className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors"
							title="Create new dashboard"
						>
							<Plus className="w-3.5 h-3.5" />
						</button>
					</div>

					{/* Right actions */}
					<div className="ml-auto flex items-center gap-2">
						{isEditing && (
							<button
								type="button"
								onClick={() => setShowAddWidget(true)}
								className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
							>
								<Plus className="w-3 h-3" />
								Add Widget
							</button>
						)}
						<button
							type="button"
							onClick={() => setIsEditing(!isEditing)}
							className={cn(
								"flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
								isEditing ? "bg-blue-600 text-white hover:bg-blue-500" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
							)}
						>
							{isEditing ? (
								<>
									<Check className="w-3 h-3" /> Done
								</>
							) : (
								<>
									<Pencil className="w-3 h-3" /> Edit
								</>
							)}
						</button>
					</div>
				</div>
			</div>

			{/* Dashboard content */}
			<div className="flex-1 overflow-y-auto p-6">
				{activeDashboard && (
					<DashboardGrid
						widgets={activeDashboard.widgets}
						metrics={metrics}
						isEditing={isEditing}
						onRemoveWidget={handleRemoveWidget}
						onConfigureWidget={handleConfigureWidget}
					/>
				)}
			</div>

			{/* Add widget dialog */}
			<AddWidgetDialog open={showAddWidget} onClose={() => setShowAddWidget(false)} onAdd={handleAddWidget} />
		</div>
	);
}
