import { Link, useMatchRoute } from "@tanstack/react-router";
import { LayoutDashboard, Workflow, Activity, BarChart3, Webhook, Settings, Search, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflows } from "@/hooks/useWorkflows";
import { STATUS_DOT_COLORS } from "@/lib/constants";

export function Sidebar() {
  const matchRoute = useMatchRoute();
  const { data: workflows } = useWorkflows();

  const navItems = [
    { to: "/", label: "Overview", icon: LayoutDashboard },
    { to: "/dashboards", label: "Dashboards", icon: LayoutGrid },
    { to: "/runs", label: "All Runs", icon: Activity },
    { to: "/metrics", label: "Metrics", icon: BarChart3 },
    { to: "/webhooks", label: "Webhooks", icon: Webhook },
  ] as const;

  return (
    <aside className="w-56 border-r border-zinc-800 bg-zinc-950 flex flex-col h-full">
      {/* Logo */}
      <div className="h-12 flex items-center px-4 border-b border-zinc-800">
        <Link to="/" className="flex items-center gap-2 font-semibold text-sm">
          <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center">
            <Workflow className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-zinc-100">Blok Studio</span>
        </Link>
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
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50",
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            );
          })}
        </div>

        {/* Workflows section */}
        {workflows && workflows.length > 0 && (
          <div className="mt-6">
            <h3 className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              Workflows
            </h3>
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
                      "flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50",
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
          className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
        >
          <Search className="w-4 h-4" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-600">
            {"\u2318"}K
          </kbd>
        </button>
        <Link
          to="/"
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
        >
          <Settings className="w-4 h-4" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
