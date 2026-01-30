import { useConnectionStore } from "@/stores/connection";
import { useNotificationStore } from "@/stores/notifications";
import { afterEach, describe, expect, it } from "vitest";

describe("connectionStore", () => {
	afterEach(() => {
		// Reset store between tests
		useConnectionStore.setState({ status: "disconnected", activeStreams: 0 });
	});

	it("starts disconnected with zero streams", () => {
		const state = useConnectionStore.getState();
		expect(state.status).toBe("disconnected");
		expect(state.activeStreams).toBe(0);
	});

	it("updates connection status", () => {
		useConnectionStore.getState().setStatus("connected");
		expect(useConnectionStore.getState().status).toBe("connected");

		useConnectionStore.getState().setStatus("error");
		expect(useConnectionStore.getState().status).toBe("error");
	});

	it("increments and decrements active streams", () => {
		const store = useConnectionStore.getState();
		store.incrementStreams();
		store.incrementStreams();
		expect(useConnectionStore.getState().activeStreams).toBe(2);

		store.decrementStreams();
		expect(useConnectionStore.getState().activeStreams).toBe(1);
	});

	it("does not decrement below zero", () => {
		useConnectionStore.getState().decrementStreams();
		expect(useConnectionStore.getState().activeStreams).toBe(0);
	});
});

describe("notificationStore", () => {
	afterEach(() => {
		useNotificationStore.setState({
			notifications: [],
			enabled: true,
			desktopEnabled: false,
		});
	});

	it("starts with empty notifications", () => {
		expect(useNotificationStore.getState().notifications).toEqual([]);
		expect(useNotificationStore.getState().enabled).toBe(true);
		expect(useNotificationStore.getState().desktopEnabled).toBe(false);
	});

	it("adds a notification", () => {
		useNotificationStore.getState().addNotification({
			type: "success",
			title: "Run completed",
			message: "countries workflow finished",
			runId: "run_123",
		});

		const notifs = useNotificationStore.getState().notifications;
		expect(notifs).toHaveLength(1);
		expect(notifs[0]!.title).toBe("Run completed");
		expect(notifs[0]!.read).toBe(false);
		expect(notifs[0]!.id).toMatch(/^notif_/);
	});

	it("newest notifications come first", () => {
		const store = useNotificationStore.getState();
		store.addNotification({ type: "success", title: "First" });
		store.addNotification({ type: "error", title: "Second" });

		const notifs = useNotificationStore.getState().notifications;
		expect(notifs[0]!.title).toBe("Second");
		expect(notifs[1]!.title).toBe("First");
	});

	it("caps at 100 notifications", () => {
		const store = useNotificationStore.getState();
		for (let i = 0; i < 110; i++) {
			store.addNotification({ type: "info", title: `Notif ${i}` });
		}
		expect(useNotificationStore.getState().notifications).toHaveLength(100);
	});

	it("marks a notification as read", () => {
		useNotificationStore.getState().addNotification({
			type: "success",
			title: "Test",
		});
		const id = useNotificationStore.getState().notifications[0]!.id;

		useNotificationStore.getState().markRead(id);
		expect(useNotificationStore.getState().notifications[0]!.read).toBe(true);
	});

	it("marks all as read", () => {
		const store = useNotificationStore.getState();
		store.addNotification({ type: "success", title: "A" });
		store.addNotification({ type: "error", title: "B" });

		store.markAllRead();
		const notifs = useNotificationStore.getState().notifications;
		expect(notifs.every((n) => n.read)).toBe(true);
	});

	it("clears all notifications", () => {
		const store = useNotificationStore.getState();
		store.addNotification({ type: "success", title: "Test" });
		store.clearAll();
		expect(useNotificationStore.getState().notifications).toEqual([]);
	});

	it("toggles enabled state", () => {
		useNotificationStore.getState().setEnabled(false);
		expect(useNotificationStore.getState().enabled).toBe(false);

		useNotificationStore.getState().setEnabled(true);
		expect(useNotificationStore.getState().enabled).toBe(true);
	});

	it("toggles desktop enabled state", () => {
		useNotificationStore.getState().setDesktopEnabled(true);
		expect(useNotificationStore.getState().desktopEnabled).toBe(true);
	});
});
