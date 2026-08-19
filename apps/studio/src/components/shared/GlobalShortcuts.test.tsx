import { ShortcutProvider } from "@/components/providers/ShortcutProvider";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalShortcuts } from "./GlobalShortcuts";

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => mockNavigate,
}));

describe("GlobalShortcuts", () => {
	const renderWithProvider = () => {
		return render(
			<ShortcutProvider>
				<GlobalShortcuts />
			</ShortcutProvider>,
		);
	};

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("navigates to /runs on 'g r'", () => {
		renderWithProvider();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));

		expect(mockNavigate).toHaveBeenCalledWith({ to: "/runs" });
	});

	it("navigates to / on 'g d'", () => {
		renderWithProvider();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));

		expect(mockNavigate).toHaveBeenCalledWith({ to: "/" });
	});

	it("navigates to /logs on 'g l'", () => {
		renderWithProvider();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "l" }));

		expect(mockNavigate).toHaveBeenCalledWith({ to: "/logs" });
	});

	it("navigates to /metrics on 'g m'", () => {
		renderWithProvider();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));

		expect(mockNavigate).toHaveBeenCalledWith({ to: "/metrics" });
	});

	it("navigates to /queues on 'g q'", () => {
		renderWithProvider();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));

		expect(mockNavigate).toHaveBeenCalledWith({ to: "/queues" });
	});

	it("navigates to /deployments on 'g v'", () => {
		renderWithProvider();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }));

		expect(mockNavigate).toHaveBeenCalledWith({ to: "/deployments" });
	});

	it("dispatches blok:open-env-switcher on 'e'", () => {
		renderWithProvider();

		const dispatchSpy = vi.spyOn(document, "dispatchEvent");
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));

		expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
		expect(dispatchSpy.mock.calls[0][0].type).toBe("blok:open-env-switcher");
	});

	it("dispatches blok:open-command-palette on 'mod+k'", () => {
		renderWithProvider();

		const dispatchSpy = vi.spyOn(document, "dispatchEvent");
		// Using ctrlKey to simulate mod
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));

		expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
		expect(dispatchSpy.mock.calls[0][0].type).toBe("blok:open-command-palette");
	});

	it("dispatches blok:open-cheat-sheet on '?'", () => {
		renderWithProvider();

		const dispatchSpy = vi.spyOn(document, "dispatchEvent");
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));

		expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
		expect(dispatchSpy.mock.calls[0][0].type).toBe("blok:open-cheat-sheet");
	});
});
