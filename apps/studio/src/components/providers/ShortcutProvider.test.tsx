import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveShortcuts, useShortcut } from "../../hooks/useShortcuts";
import { ShortcutProvider } from "./ShortcutProvider";

describe("ShortcutProvider", () => {
	const TestComponent = ({
		combo,
		onTrigger,
		options,
	}: {
		combo: string;
		onTrigger: (e: KeyboardEvent) => void;
		options?: { description?: string; ignoreFocus?: boolean };
	}) => {
		useShortcut(combo, onTrigger, options);
		return <div>Shortcut Active</div>;
	};

	it("triggers single key shortcuts", async () => {
		const user = userEvent.setup();
		const onTrigger = vi.fn();

		render(
			<ShortcutProvider>
				<TestComponent combo="?" onTrigger={onTrigger} />
			</ShortcutProvider>,
		);

		await user.keyboard("?");
		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("triggers modifier shortcuts", async () => {
		const user = userEvent.setup();
		const onTrigger = vi.fn();

		render(
			<ShortcutProvider>
				<TestComponent combo="Mod+K" onTrigger={onTrigger} />
			</ShortcutProvider>,
		);

		await user.keyboard("{Control>}k{/Control}");
		expect(onTrigger).toHaveBeenCalledTimes(1);

		onTrigger.mockClear();

		await user.keyboard("{Meta>}k{/Meta}");
		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("triggers sequences", async () => {
		const user = userEvent.setup();
		const onTrigger = vi.fn();

		render(
			<ShortcutProvider>
				<TestComponent combo="g r" onTrigger={onTrigger} />
			</ShortcutProvider>,
		);

		await user.keyboard("g");
		expect(onTrigger).not.toHaveBeenCalled();

		await user.keyboard("r");
		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("times out sequences after 500ms", async () => {
		vi.useFakeTimers();
		const onTrigger = vi.fn();

		render(
			<ShortcutProvider>
				<TestComponent combo="g r" onTrigger={onTrigger} />
			</ShortcutProvider>,
		);

		fireEvent.keyDown(window, { key: "g" });

		act(() => {
			vi.advanceTimersByTime(600);
		});

		fireEvent.keyDown(window, { key: "r" });
		expect(onTrigger).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("suppresses focus on inputs by default", async () => {
		const user = userEvent.setup();
		const onTrigger = vi.fn();

		render(
			<ShortcutProvider>
				<input data-testid="input" />
				<TestComponent combo="a" onTrigger={onTrigger} />
			</ShortcutProvider>,
		);

		const input = screen.getByTestId("input");
		await user.click(input);
		expect(input).toHaveFocus();

		await user.keyboard("a");
		expect(onTrigger).not.toHaveBeenCalled();
	});

	it("does not suppress if ignoreFocus is true", async () => {
		const user = userEvent.setup();
		const onTrigger = vi.fn();

		render(
			<ShortcutProvider>
				<input data-testid="input" />
				<TestComponent combo="a" onTrigger={onTrigger} options={{ ignoreFocus: true }} />
			</ShortcutProvider>,
		);

		const input = screen.getByTestId("input");
		await user.click(input);

		await user.keyboard("a");
		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("exposes active shortcuts", () => {
		const ActiveShortcutsList = () => {
			const shortcuts = useActiveShortcuts();
			return (
				<ul>
					{shortcuts.map((s, i) => (
						<li key={s.keyCombo} data-testid="shortcut-item">
							{s.keyCombo} - {s.description}
						</li>
					))}
				</ul>
			);
		};

		render(
			<ShortcutProvider>
				<TestComponent combo="Mod+K" onTrigger={() => {}} options={{ description: "Search" }} />
				<ActiveShortcutsList />
			</ShortcutProvider>,
		);

		const items = screen.getAllByTestId("shortcut-item");
		expect(items).toHaveLength(1);
		expect(items[0].textContent).toBe("Mod+K - Search");
	});
});
