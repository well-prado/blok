import { cn } from "@/lib/utils";
import { Link, useMatchRoute, useRouterState } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

interface SideMenuItemProps {
	to: string;
	label: string;
	icon: LucideIcon;
	isCollapsed?: boolean;
	params?: Record<string, string>;
	rightElement?: React.ReactNode;
}

export function SideMenuItem({ to, label, icon: Icon, isCollapsed, params, rightElement }: SideMenuItemProps) {
	const matchRoute = useMatchRoute();
	const location = useRouterState({ select: (s) => s.location });
	const isActive = !!matchRoute({ to, params, fuzzy: to !== "/" }) || (to === "/" && location.pathname === "/");

	return (
		<Link
			to={to as unknown as never}
			params={params as unknown as never}
			className={cn(
				"group relative flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors",
				isActive
					? "bg-blok-green-500/10 text-zinc-100 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:rounded-r before:bg-blok-green-500 before:content-['']"
					: "text-zinc-400 hover:bg-hover hover:text-zinc-200",
				isCollapsed ? "justify-center px-0" : "",
			)}
			title={isCollapsed ? label : undefined}
		>
			<div className={cn("flex items-center gap-2", isCollapsed ? "w-full justify-center" : "min-w-0")}>
				<Icon
					className={cn("h-4 w-4 shrink-0", isActive ? "text-zinc-100" : "text-zinc-500 group-hover:text-zinc-300")}
				/>
				{!isCollapsed && <span className="truncate">{label}</span>}
			</div>
			{!isCollapsed && rightElement && <div className="flex shrink-0 items-center">{rightElement}</div>}
		</Link>
	);
}
