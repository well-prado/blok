import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistentState } from "./usePersistentState";

describe("usePersistentState", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("initializes from the default when nothing is stored yet", () => {
		const { result } = renderHook(() => usePersistentState("test.key", "fallback"));
		expect(result.current[0]).toBe("fallback");
	});

	it("reads a previously persisted value on mount", () => {
		localStorage.setItem("test.key", "stored");
		const { result } = renderHook(() => usePersistentState("test.key", "fallback"));
		expect(result.current[0]).toBe("stored");
	});

	it("writes through the setter, including the updater-function form", () => {
		const { result } = renderHook(() => usePersistentState("test.key", "a"));
		act(() => result.current[1]("b"));
		expect(result.current[0]).toBe("b");
		expect(localStorage.getItem("test.key")).toBe("b");

		act(() => result.current[1]((current) => `${current}c`));
		expect(result.current[0]).toBe("bc");
		expect(localStorage.getItem("test.key")).toBe("bc");
	});

	it("falls back to the default when localStorage.getItem throws (private mode)", () => {
		vi.spyOn(localStorage, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const { result } = renderHook(() => usePersistentState("test.key", "fallback"));
		expect(result.current[0]).toBe("fallback");
		vi.restoreAllMocks();
	});

	it("keeps in-memory state even when localStorage.setItem throws", () => {
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});
		const { result } = renderHook(() => usePersistentState("test.key", "a"));
		act(() => result.current[1]("b"));
		expect(result.current[0]).toBe("b");
		vi.restoreAllMocks();
	});

	it("decodes a corrupt raw value via the custom deserializer's own fallback", () => {
		localStorage.setItem("blok-studio.canvas.fullscreen", "garbage");
		const { result } = renderHook(() =>
			usePersistentState<boolean>(
				"blok-studio.canvas.fullscreen",
				false,
				(value) => (value ? "1" : "0"),
				(raw) => raw === "1",
			),
		);
		// Anything other than the exact "1" sentinel reads back as false —
		// a corrupt/foreign value degrades to the default, never throws.
		expect(result.current[0]).toBe(false);
	});

	it("round-trips the boolean fullscreen encoding used by WorkflowGraph", () => {
		const serialize = (value: boolean) => (value ? "1" : "0");
		const deserialize = (raw: string) => raw === "1";

		const { result, rerender } = renderHook(() =>
			usePersistentState<boolean>("blok-studio.canvas.fullscreen", false, serialize, deserialize),
		);
		expect(result.current[0]).toBe(false);

		act(() => result.current[1](true));
		expect(localStorage.getItem("blok-studio.canvas.fullscreen")).toBe("1");

		rerender();
		const { result: reread } = renderHook(() =>
			usePersistentState<boolean>("blok-studio.canvas.fullscreen", false, serialize, deserialize),
		);
		expect(reread.current[0]).toBe(true);
	});
});
