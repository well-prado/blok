import { Sidebar } from "@/components/layout/Sidebar";
import { StatusBar } from "@/components/layout/StatusBar";
import { ShortcutProvider } from "@/components/providers/ShortcutProvider";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { GlobalShortcuts } from "@/components/shared/GlobalShortcuts";
import { KeyboardCheatSheet } from "@/components/shared/KeyboardCheatSheet";
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
		<ShortcutProvider>
			<div className="h-screen flex flex-col bg-canvas">
				<GlobalShortcuts />
				<div className="flex flex-1 overflow-hidden">
					<Sidebar />
					<main className="flex-1 overflow-y-auto bg-raised">
						<ErrorBoundary>
							<Outlet />
						</ErrorBoundary>
					</main>
				</div>
				<StatusBar />
				<CommandPalette />
				<NotificationToast />
				<KeyboardCheatSheet />
			</div>
		</ShortcutProvider>
	);
}
