import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTableSelection } from "./useTableSelection";

const IDS = ["a", "b", "c", "d"];

describe("useTableSelection", () => {
	it("toggles one id on and back off", () => {
		const { result } = renderHook(() => useTableSelection(IDS));
		expect(result.current.has("b")).toBe(false);

		act(() => result.current.toggle("b"));
		expect(result.current.has("b")).toBe(true);
		expect(result.current.someSelected).toBe(true);
		expect(result.current.allSelected).toBe(false);

		act(() => result.current.toggle("b"));
		expect(result.current.has("b")).toBe(false);
		expect(result.current.someSelected).toBe(false);
	});

	it("drives the select-all checkbox's three states", () => {
		const { result } = renderHook(() => useTableSelection(IDS));
		// unchecked
		expect(result.current.allSelected).toBe(false);
		expect(result.current.someSelected).toBe(false);

		// indeterminate — the state the reference never renders at all
		act(() => result.current.toggle("a"));
		expect(result.current.someSelected && !result.current.allSelected).toBe(true);

		// checked
		act(() => result.current.selectAll());
		expect(result.current.allSelected).toBe(true);
		expect(result.current.someSelected && !result.current.allSelected).toBe(false);

		act(() => result.current.clear());
		expect(result.current.selected.size).toBe(0);
		expect(result.current.allSelected).toBe(false);
	});

	it("never reports allSelected for an empty page", () => {
		const { result } = renderHook(() => useTableSelection([]));
		act(() => result.current.selectAll());
		expect(result.current.allSelected).toBe(false);
	});

	it("selects an inclusive range in visual order, in both directions", () => {
		const { result } = renderHook(() => useTableSelection(IDS));

		act(() => result.current.selectRange("b", "d"));
		expect([...result.current.selected].sort()).toEqual(["b", "c", "d"]);

		act(() => result.current.clear());
		// Backwards — the anchor may be BELOW the clicked row.
		act(() => result.current.selectRange("d", "b"));
		expect([...result.current.selected].sort()).toEqual(["b", "c", "d"]);
	});

	it("ignores a range whose endpoint is not on the page", () => {
		const { result } = renderHook(() => useTableSelection(IDS));
		act(() => result.current.selectRange("a", "zzz"));
		expect(result.current.selected.size).toBe(0);
	});

	it("extends from the last-touched row on a shift-toggle", () => {
		const { result } = renderHook(() => useTableSelection(IDS));
		act(() => result.current.toggle("a"));
		act(() => result.current.toggle("c", true));
		expect([...result.current.selected].sort()).toEqual(["a", "b", "c"]);
	});

	it("toggles normally when a shift-toggle has no anchor yet", () => {
		const { result } = renderHook(() => useTableSelection(IDS));
		act(() => result.current.toggle("c", true));
		expect([...result.current.selected]).toEqual(["c"]);
	});

	it("refuses additions past `max` instead of truncating silently", () => {
		const { result } = renderHook(() => useTableSelection(IDS, { max: 2 }));

		act(() => result.current.selectAll());
		// Capped at 2, in visual order — and the user is TOLD, via atMax.
		expect([...result.current.selected]).toEqual(["a", "b"]);
		expect(result.current.atMax).toBe(true);
		expect(result.current.allSelected).toBe(false);

		act(() => result.current.toggle("d"));
		expect(result.current.has("d")).toBe(false);

		// Deselection is never refused, and it reopens the cap.
		act(() => result.current.toggle("a"));
		expect(result.current.atMax).toBe(false);
		act(() => result.current.toggle("d"));
		expect([...result.current.selected].sort()).toEqual(["b", "d"]);
	});

	it("leaves atMax false when no cap was given", () => {
		const { result } = renderHook(() => useTableSelection(IDS));
		act(() => result.current.selectAll());
		expect(result.current.atMax).toBe(false);
		expect(result.current.allSelected).toBe(true);
	});
});
