import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShortcutKey } from "./ShortcutKey";

describe("ShortcutKey", () => {
	let originalNavigator: unknown;

	beforeEach(() => {
		originalNavigator = global.navigator;
	});

	afterEach(() => {
		Object.defineProperty(global, "navigator", {
			value: originalNavigator,
			writable: true,
		});
	});

	function mockMac() {
		Object.defineProperty(global, "navigator", {
			value: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
			writable: true,
		});
	}

	function mockWindows() {
		Object.defineProperty(global, "navigator", {
			value: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
			writable: true,
		});
	}

	it("renders basic shortcut on Mac", () => {
		mockMac();
		const { container } = render(<ShortcutKey shortcut="F" />);
		expect(container.textContent).toBe("F");
	});

	it("renders combination on Mac", () => {
		mockMac();
		const { container } = render(<ShortcutKey shortcut="Mod+K" />);
		expect(container.textContent).toBe("⌘K");
	});

	it("renders combination with shift and alt on Mac", () => {
		mockMac();
		const { container } = render(<ShortcutKey shortcut="Shift+Alt+Mod+K" />);
		expect(container.textContent).toBe("⇧⌥⌘K");
	});

	it("renders sequences on Mac", () => {
		mockMac();
		const { container } = render(<ShortcutKey shortcut="g r" />);
		const kbds = container.querySelectorAll("kbd");
		expect(kbds.length).toBe(2);
		expect(kbds[0]?.textContent).toBe("g");
		expect(kbds[1]?.textContent).toBe("r");
	});

	it("renders combination on Windows", () => {
		mockWindows();
		const { container } = render(<ShortcutKey shortcut="Mod+K" />);
		expect(container.textContent).toBe("Ctrl+K");
	});

	it("renders combination with shift and alt on Windows", () => {
		mockWindows();
		const { container } = render(<ShortcutKey shortcut="Shift+Alt+Mod+K" />);
		expect(container.textContent).toBe("Shift+Alt+Ctrl+K");
	});

	it("renders sequences on Windows", () => {
		mockWindows();
		const { container } = render(<ShortcutKey shortcut="g r" />);
		const kbds = container.querySelectorAll("kbd");
		expect(kbds.length).toBe(2);
		expect(kbds[0]?.textContent).toBe("g");
		expect(kbds[1]?.textContent).toBe("r");
	});

	it("renders sequences with combination on Windows", () => {
		mockWindows();
		const { container } = render(<ShortcutKey shortcut="Mod+K g" />);
		const kbds = container.querySelectorAll("kbd");
		expect(kbds.length).toBe(2);
		expect(kbds[0]?.textContent).toBe("Ctrl+K");
		expect(kbds[1]?.textContent).toBe("g");
	});
});
