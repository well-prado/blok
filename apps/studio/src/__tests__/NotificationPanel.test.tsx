import { NotificationPanel } from "@/components/layout/NotificationPanel";
import { useNotificationStore } from "@/stores/notifications";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

// Mock pointer events for Radix UI
if (typeof window !== "undefined") {
	window.HTMLElement.prototype.hasPointerCapture = vi.fn();
	window.HTMLElement.prototype.releasePointerCapture = vi.fn();
	window.HTMLElement.prototype.setPointerCapture = vi.fn();
}

// Mock dateUtils to ensure deterministic tests
vi.mock("@/lib/dateUtils", () => ({
	formatTimeAgo: () => "just now",
}));

beforeEach(() => {
	useNotificationStore.setState({
		notifications: [
			{
				id: "1",
				type: "success",
				title: "Workflow Complete",
				message: "Run finished successfully",
				timestamp: Date.now(),
				read: false,
			},
			{
				id: "2",
				type: "error",
				title: "Workflow Failed",
				timestamp: Date.now() - 10000,
				read: true,
			},
		],
	});
});

test("renders notification button with unread badge", () => {
	render(<NotificationPanel />);
	const button = screen.getByRole("button", { name: "Notifications" });
	expect(button).toBeInTheDocument();
	expect(screen.getByText("1")).toBeInTheDocument();
});

test("opens panel and shows notifications", async () => {
	const user = userEvent.setup();
	render(<NotificationPanel />);

	const trigger = screen.getByRole("button", { name: "Notifications" });
	await user.click(trigger);

	const dialog = screen.getByRole("dialog");
	expect(dialog).toBeInTheDocument();

	expect(within(dialog).getByText("Workflow Complete")).toBeInTheDocument();
	expect(within(dialog).getByText("Run finished successfully")).toBeInTheDocument();
	expect(within(dialog).getByText("Workflow Failed")).toBeInTheDocument();
});

test("marks individual notification as read", async () => {
	const user = userEvent.setup();
	render(<NotificationPanel />);

	await user.click(screen.getByRole("button", { name: "Notifications" }));

	const successCard = screen.getByText("Workflow Complete").closest("div[role='button']");
	expect(successCard).toBeInTheDocument();

	await user.click(successCard as HTMLElement);

	const notifications = useNotificationStore.getState().notifications;
	expect(notifications.find((n) => n.id === "1")?.read).toBe(true);
});

test("marks all notifications as read", async () => {
	const user = userEvent.setup();
	render(<NotificationPanel />);

	await user.click(screen.getByRole("button", { name: "Notifications" }));

	const markAllReadBtn = screen.getByRole("button", { name: /mark all read/i });
	await user.click(markAllReadBtn);

	const notifications = useNotificationStore.getState().notifications;
	expect(notifications.every((n) => n.read)).toBe(true);
});

test("clears all notifications", async () => {
	const user = userEvent.setup();
	render(<NotificationPanel />);

	await user.click(screen.getByRole("button", { name: "Notifications" }));

	const clearAllBtn = screen.getByRole("button", { name: "Clear all" });
	await user.click(clearAllBtn);

	const notifications = useNotificationStore.getState().notifications;
	expect(notifications.length).toBe(0);
});
