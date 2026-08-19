import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutContext } from "../providers/ShortcutProvider";
import { KeyboardCheatSheet } from "./KeyboardCheatSheet";

const mockShortcuts = [
	{ keyCombo: "mod+k", description: "Open command palette" },
	{ keyCombo: "shift+?", description: "Open cheat sheet" },
];

function TestWrapper({ children }: { children: React.ReactNode }) {
	return (
		<ShortcutContext.Provider
			value={{
				registerShortcut: vi.fn(),
				unregisterShortcut: vi.fn(),
				activeShortcuts: mockShortcuts,
			}}
		>
			{children}
		</ShortcutContext.Provider>
	);
}

describe("KeyboardCheatSheet", () => {
	it("opens on blok:open-cheat-sheet event and displays shortcuts", () => {
		render(
			<TestWrapper>
				<KeyboardCheatSheet />
			</TestWrapper>,
		);

		// Initially not visible
		expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();

		// Dispatch event
		fireEvent(window, new CustomEvent("blok:open-cheat-sheet"));

		// Should be visible
		expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
		expect(screen.getByText("Open command palette")).toBeInTheDocument();
		expect(screen.getByText("Open cheat sheet")).toBeInTheDocument();
	});

	it("renders empty state when no shortcuts are active", () => {
		render(
			<ShortcutContext.Provider
				value={{
					registerShortcut: vi.fn(),
					unregisterShortcut: vi.fn(),
					activeShortcuts: [],
				}}
			>
				<KeyboardCheatSheet open={true} />
			</ShortcutContext.Provider>,
		);

		expect(screen.getByText("No shortcuts active.")).toBeInTheDocument();
	});
});
