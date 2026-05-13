import { BlokMark } from "@/components/shared/BlokMark";
import { EnvChip } from "@/components/shared/EnvChip";
import { useWorkflows } from "@/hooks/useWorkflows";
import { STATUS_DOT_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
	Activity,
	BarChart3,
	CalendarClock,
	FileText,
	GitBranch,
	LayoutDashboard,
	LayoutGrid,
	Search,
	Settings,
	Timer,
	Webhook,
} from "lucide-react";

/**
 * Direction A \u00b7 Linear-grade Operator. Sidebar wears the only piece of
 * brand color in the chrome: the real Blok mark above the env chip,
 * plus a brand-green left edge + tinted background on the active nav
 * item. Active state pattern is reused on workflow rows for parity.
 *
 * The previous incarnation had a Lucide Workflow icon in a foreign
 * `bg-blue-600` square \u2014 replaced because it had no relationship to
 * the actual Blok wordmark and was the most visible "this is a generic
 * Tailwind dashboard" tell.
 */
export function Sidebar() {
	const matchRoute = useMatchRoute();
	const { data: workflows } = useWorkflows();

	const navItems = [
		{ to: "/", label: "Overview", icon: LayoutDashboard },
		{ to: "/dashboards", label: "Dashboards", icon: LayoutGrid },
		{ to: "/runs", label: "All Runs", icon: Activity },
		{ to: "/scheduled", label: "Scheduled", icon: CalendarClock },
		{ to: "/logs", label: "Logs", icon: FileText },
		{ to: "/queues", label: "Queues", icon: Timer },
		{ to: "/deployments", label: "Deployments", icon: GitBranch },
		{ to: "/metrics", label: "Metrics", icon: BarChart3 },
		{ to: "/webhooks", label: "Webhooks", icon: Webhook },
	] as const;

	return (
		<aside className="w-56 border-r border-zinc-800 bg-canvas flex flex-col h-full">
			{/* Brand lockup + env chip */}
			<div className="px-3 pt-3 pb-2 border-b border-zinc-800 space-y-2">
				<Link to="/" className="flex items-center gap-2 px-1.5 py-1 rounded">
					<BlokMark className="h-4 w-auto shrink-0" />
					<span className="text-zinc-100 font-semibold text-sm tracking-tight">blok</span>
				</Link>
				<EnvChip />
			</div>

			{/* Main nav */}
			<nav className="flex-1 overflow-y-auto py-2 px-2">
				<div className="space-y-0.5">
					{navItems.map(({ to, label, icon: Icon }) => {
						const isActive = matchRoute({ to, fuzzy: to !== "/" }) || (to === "/" && location.pathname === "/");
						return (
							<Link
								key={to}
								to={to}
								className={cn(
									"relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
									isActive
										? "bg-blok-green-500/10 text-zinc-100 before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:bg-blok-green-500 before:rounded-r"
										: "text-zinc-400 hover:text-zinc-200 hover:bg-hover",
								)}
							>
								<Icon className={cn("w-4 h-4", isActive ? "text-zinc-100" : "text-zinc-500")} />
								{label}
							</Link>
						);
					})}
				</div>

				{/* Workflows section */}
				{workflows && workflows.length > 0 && (
					<div className="mt-6">
						<h3 className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Workflows</h3>
						<div className="space-y-0.5">
							{workflows.map((wf) => {
								const isActive = !!matchRoute({
									to: "/workflows/$name",
									params: { name: wf.name },
									fuzzy: true,
								});
								return (
									<Link
										key={wf.name}
										to="/workflows/$name"
										params={{ name: wf.name }}
										className={cn(
											"relative flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors",
											isActive
												? "bg-blok-green-500/10 text-zinc-100 before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:bg-blok-green-500 before:rounded-r"
												: "text-zinc-400 hover:text-zinc-200 hover:bg-hover",
										)}
									>
										<span className="truncate">{wf.name}</span>
										{wf.lastRunStatus && (
											<span
												className={cn(
													"w-2 h-2 rounded-full shrink-0",
													STATUS_DOT_COLORS[wf.lastRunStatus],
													wf.lastRunStatus === "running" && "animate-pulse-dot",
												)}
											/>
										)}
									</Link>
								);
							})}
						</div>
					</div>
				)}
			</nav>

			{/* Bottom */}
			<div className="border-t border-zinc-800 p-2 space-y-0.5">
				<button
					type="button"
					onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
					className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-hover transition-colors"
				>
					<Search className="w-4 h-4" />
					<span className="flex-1 text-left">Search</span>
					<kbd className="text-[10px] px-1 py-0.5 rounded bg-raised border border-zinc-800 text-zinc-500">
						{"\u2318"}K
					</kbd>
				</button>
				<Link
					to="/settings"
					className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-hover transition-colors [&.active]:bg-blok-green-500/10 [&.active]:text-zinc-100"
					activeProps={{ className: "active" }}
				>
					<Settings className="w-4 h-4" />
					Settings
				</Link>
			</div>
		</aside>
	);
}
