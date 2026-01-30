import { Sidebar } from "@/components/layout/Sidebar";
import { StatusBar } from "@/components/layout/StatusBar";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { NotificationToast } from "@/components/shared/NotificationToast";
import { useGlobalStream } from "@/hooks/useGlobalStream";
import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
});

function RootLayout() {
	// Global SSE stream — lives at the root so it persists across page navigations
	useGlobalStream();

	return (
		<div className="h-screen flex flex-col bg-zinc-950">
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex-1 overflow-y-auto bg-zinc-925">
					<ErrorBoundary>
						<Outlet />
					</ErrorBoundary>
				</main>
			</div>
			<StatusBar />
			<CommandPalette />
			<NotificationToast />
		</div>
	);
}
