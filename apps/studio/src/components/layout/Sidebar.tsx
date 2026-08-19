import { NotificationPanel } from "@/components/layout/NotificationPanel";
import { BlokMark } from "@/components/shared/BlokMark";
import { EnvironmentSelector } from "@/components/shared/EnvironmentSelector";
import { useWorkflows } from "@/hooks/useWorkflows";
import { STATUS_DOT_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useNavigationStore } from "@/stores/navigation";
import { Link } from "@tanstack/react-router";
import {
	Activity,
	BarChart3,
	Blocks,
	CalendarClock,
	FileText,
	GitBranch,
	LayoutDashboard,
	LayoutGrid,
	PanelLeftClose,
	PanelLeftOpen,
	Search,
	Settings,
	Settings2,
	Timer,
	Webhook,
	Workflow,
} from "lucide-react";
import { useState } from "react";
import { CustomizeSidebarDialog } from "./CustomizeSidebarDialog";
import { FavoritePageButton } from "./FavoritePageButton";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";

const ALL_NAV_ITEMS = [
	{ id: "/", to: "/", label: "Overview", icon: LayoutDashboard },
	{ id: "/dashboards", to: "/dashboards", label: "Dashboards", icon: LayoutGrid },
	{ id: "/runs", to: "/runs", label: "All Runs", icon: Activity },
	{ id: "/scheduled", to: "/scheduled", label: "Scheduled", icon: CalendarClock },
	{ id: "/logs", to: "/logs", label: "Logs", icon: FileText },
	{ id: "/queues", to: "/queues", label: "Queues", icon: Timer },
	{ id: "/deployments", to: "/deployments", label: "Deployments", icon: GitBranch },
	{ id: "/metrics", to: "/metrics", label: "Metrics", icon: BarChart3 },
	{ id: "/webhooks", to: "/webhooks", label: "Webhooks", icon: Webhook },
	{ id: "/catalog", to: "/catalog", label: "Catalog", icon: Blocks },
] as const;

export function Sidebar() {
	const { data: workflows } = useWorkflows();
	const isCollapsed = useNavigationStore((s) => s.isCollapsed);
	const toggleCollapse = useNavigationStore((s) => s.toggleCollapse);
	const navOrder = useNavigationStore((s) => s.navOrder);
	const favorites = useNavigationStore((s) => s.favorites);
	const [customizeOpen, setCustomizeOpen] = useState(false);

	const sortedNavItems = [...ALL_NAV_ITEMS].sort((a, b) => {
		const indexA = navOrder.indexOf(a.id);
		const indexB = navOrder.indexOf(b.id);
		const posA = indexA === -1 ? ALL_NAV_ITEMS.length : indexA;
		const posB = indexB === -1 ? ALL_NAV_ITEMS.length : indexB;
		return posA - posB;
	});

	// Compute favorite items. Can be from ALL_NAV_ITEMS or workflows.
	const favoriteItems = favorites
		.map((id) => {
			const staticItem = ALL_NAV_ITEMS.find((item) => item.id === id);
			if (staticItem) return { ...staticItem, type: "static" as const };

			if (id.startsWith("/workflows/")) {
				const wfName = id.replace("/workflows/", "");
				const wf = workflows?.find((w) => w.name === wfName);
				if (wf) {
					return {
						id,
						to: "/workflows/$name",
						params: { name: wf.name },
						label: wf.name,
						icon: Workflow,
						type: "workflow" as const,
						status: wf.lastRunStatus,
					};
				}
			}
			return null;
		})
		.filter((x) => x !== null);

	return (
		<aside
			className={cn(
				"border-r border-zinc-800 bg-canvas flex flex-col h-full transition-[width] duration-200 ease-in-out",
				isCollapsed ? "w-[52px]" : "w-56",
			)}
		>
			<div className={cn("pt-3 pb-2 border-b border-zinc-800 space-y-2", isCollapsed ? "px-1.5" : "px-3")}>
				<Link to="/" className={cn("flex items-center rounded py-1", isCollapsed ? "justify-center" : "gap-2 px-1.5")}>
					<BlokMark className="h-4 w-auto shrink-0" />
					{!isCollapsed && <span className="text-zinc-100 font-semibold text-sm tracking-tight">blok</span>}
				</Link>
				{!isCollapsed && <EnvironmentSelector />}
			</div>

			<nav className="flex-1 overflow-y-auto py-2 px-2">
				{favoriteItems.length > 0 && (
					<SideMenuSection title="Favorites" isCollapsed={isCollapsed}>
						{favoriteItems.map((item) => (
							<SideMenuItem
								key={item.id}
								to={item.to}
								params={item.type === "workflow" ? item.params : undefined}
								label={item.label}
								icon={item.icon}
								isCollapsed={isCollapsed}
								rightElement={
									<div className="flex items-center gap-1.5">
										{item.type === "workflow" && item.status && (
											<span
												className={cn(
													"w-2 h-2 rounded-full shrink-0",
													STATUS_DOT_COLORS[item.status as keyof typeof STATUS_DOT_COLORS],
													item.status === "running" && "animate-pulse-dot",
												)}
											/>
										)}
										<FavoritePageButton id={item.id} isHoverOnly />
									</div>
								}
							/>
						))}
					</SideMenuSection>
				)}

				<SideMenuSection
					title="Menu"
					isCollapsed={isCollapsed}
					action={
						<button
							type="button"
							onClick={() => setCustomizeOpen(true)}
							className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded-md transition-colors"
						>
							<Settings2 className="w-3.5 h-3.5" />
						</button>
					}
				>
					{sortedNavItems.map((item) => (
						<SideMenuItem
							key={item.id}
							to={item.to}
							label={item.label}
							icon={item.icon}
							isCollapsed={isCollapsed}
							rightElement={<FavoritePageButton id={item.id} isHoverOnly />}
						/>
					))}
				</SideMenuSection>

				{workflows && workflows.length > 0 && (
					<SideMenuSection title="Workflows" isCollapsed={isCollapsed}>
						{workflows.map((wf) => {
							const wfId = `/workflows/${wf.name}`;
							return (
								<SideMenuItem
									key={wf.name}
									to="/workflows/$name"
									params={{ name: wf.name }}
									label={wf.name}
									icon={Workflow}
									isCollapsed={isCollapsed}
									rightElement={
										<div className="flex items-center gap-1.5">
											{wf.lastRunStatus && (
												<span
													className={cn(
														"w-2 h-2 rounded-full shrink-0",
														STATUS_DOT_COLORS[wf.lastRunStatus],
														wf.lastRunStatus === "running" && "animate-pulse-dot",
													)}
												/>
											)}
											<FavoritePageButton id={wfId} isHoverOnly />
										</div>
									}
								/>
							);
						})}
					</SideMenuSection>
				)}
			</nav>

			<div className="border-t border-zinc-800 p-2 space-y-0.5">
				<button
					type="button"
					onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
					className={cn(
						"w-full flex items-center rounded-md py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-hover transition-colors group",
						isCollapsed ? "justify-center px-0" : "gap-2 px-2.5",
					)}
					title={isCollapsed ? "Search" : undefined}
				>
					<Search className="w-4 h-4 shrink-0" />
					{!isCollapsed && (
						<>
							<span className="flex-1 text-left">Search</span>
							<kbd className="text-[10px] px-1 py-0.5 rounded bg-raised border border-zinc-800 text-zinc-500">
								{"\u2318"}K
							</kbd>
						</>
					)}
				</button>
				<NotificationPanel />
				<Link
					to="/settings"
					className={cn(
						"flex items-center rounded-md py-1.5 text-sm transition-colors group [&.active]:bg-blok-green-500/10 [&.active]:text-zinc-100",
						isCollapsed ? "justify-center px-0" : "gap-2 px-2.5 text-zinc-500 hover:text-zinc-300 hover:bg-hover",
					)}
					activeProps={{ className: "active" }}
					title={isCollapsed ? "Settings" : undefined}
				>
					<Settings className={cn("w-4 h-4 shrink-0", isCollapsed && "text-zinc-500 group-hover:text-zinc-300")} />
					{!isCollapsed && "Settings"}
				</Link>
				<button
					type="button"
					onClick={toggleCollapse}
					className={cn(
						"w-full flex items-center rounded-md py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-hover transition-colors group",
						isCollapsed ? "justify-center px-0" : "gap-2 px-2.5",
					)}
					title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
				>
					{isCollapsed ? (
						<PanelLeftOpen className="w-4 h-4 shrink-0" />
					) : (
						<PanelLeftClose className="w-4 h-4 shrink-0" />
					)}
					{!isCollapsed && "Collapse"}
				</button>
			</div>

			<CustomizeSidebarDialog
				items={ALL_NAV_ITEMS.map((i) => ({ id: i.id, label: i.label }))}
				open={customizeOpen}
				onOpenChange={setCustomizeOpen}
			/>
		</aside>
	);
}
