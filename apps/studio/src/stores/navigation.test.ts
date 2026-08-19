import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore } from "./navigation";

describe("useNavigationStore", () => {
	beforeEach(() => {
		useNavigationStore.setState({
			isCollapsed: false,
			favorites: [],
			navOrder: [
				"/",
				"/dashboards",
				"/runs",
				"/scheduled",
				"/logs",
				"/queues",
				"/deployments",
				"/metrics",
				"/webhooks",
				"/catalog",
			],
		});
	});

	it("should toggle collapse state", () => {
		const store = useNavigationStore.getState();
		expect(store.isCollapsed).toBe(false);

		store.toggleCollapse();
		expect(useNavigationStore.getState().isCollapsed).toBe(true);

		useNavigationStore.getState().setCollapsed(false);
		expect(useNavigationStore.getState().isCollapsed).toBe(false);
	});

	it("should toggle favorites", () => {
		const store = useNavigationStore.getState();
		expect(store.favorites).toEqual([]);

		store.toggleFavorite("/dashboards");
		expect(useNavigationStore.getState().favorites).toEqual(["/dashboards"]);

		useNavigationStore.getState().toggleFavorite("/dashboards");
		expect(useNavigationStore.getState().favorites).toEqual([]);
	});

	it("should set nav order", () => {
		const store = useNavigationStore.getState();
		store.setNavOrder(["/logs", "/dashboards", "/"]);
		expect(useNavigationStore.getState().navOrder).toEqual(["/logs", "/dashboards", "/"]);
	});
});
