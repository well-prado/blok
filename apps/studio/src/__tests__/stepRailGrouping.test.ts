import type { NodeRun } from "@/types";
import { describe, expect, it } from "vitest";
import { buildRailItems } from "../components/trace/StepRail";

/**
 * StepRail's iteration-header insertion (v0.5.3) is a pure function over
 * the sorted NodeRun list — these tests pin it. The renderer is just
 * UI; the grouping decisions live in `buildRailItems`.
 *
 * Test fixtures use minimal NodeRun shape — only the fields the function
 * reads (`id`, `depth`, `iterationIndex`, plus an `nodeName` for
 * recognizable ordering). Type-cast through `unknown` to avoid building
 * full NodeRuns for what's effectively a structural test.
 */
function makeNode(id: string, depth: number, iterationIndex: number | undefined, nodeName = id): NodeRun {
	return {
		id,
		runId: "run-1",
		nodeName,
		nodeType: "module",
		status: "completed",
		startedAt: 0,
		depth,
		stepIndex: 0,
		iterationIndex,
	} as unknown as NodeRun;
}

describe("StepRail.buildRailItems — iteration grouping", () => {
	it("inserts no headers when no node carries iterationIndex", () => {
		const items = buildRailItems([makeNode("a", 0, undefined), makeNode("b", 0, undefined)]);
		expect(items.length).toBe(2);
		expect(items.every((i) => i.kind === "node")).toBe(true);
	});

	it("inserts a single header before the first iteration step", () => {
		const items = buildRailItems([
			makeNode("forEach", 0, undefined, "process-items"),
			makeNode("step-1", 1, 0),
			makeNode("step-2", 1, 0),
		]);
		// [forEach, header(0), step-1, step-2]
		expect(items.length).toBe(4);
		expect(items[0]).toMatchObject({ kind: "node" });
		expect(items[1]).toMatchObject({ kind: "iteration-header", iterIndex: 0, depth: 1 });
		expect(items[2]).toMatchObject({ kind: "node" });
		expect(items[3]).toMatchObject({ kind: "node" });
	});

	it("inserts one header per iteration boundary among siblings", () => {
		// 3 iterations × 2 inner steps = 6 nodes + 3 headers = 9 items
		const items = buildRailItems([
			makeNode("step-1-iter0", 1, 0),
			makeNode("step-2-iter0", 1, 0),
			makeNode("step-1-iter1", 1, 1),
			makeNode("step-2-iter1", 1, 1),
			makeNode("step-1-iter2", 1, 2),
			makeNode("step-2-iter2", 1, 2),
		]);
		const headers = items.filter((i) => i.kind === "iteration-header");
		expect(headers).toHaveLength(3);
		// iter indices in encounter order
		expect(headers.map((h) => (h as { iterIndex: number }).iterIndex)).toEqual([0, 1, 2]);
		// header always at depth 1 (sibling-row depth)
		expect(headers.every((h) => (h as { depth: number }).depth === 1)).toBe(true);
	});

	it("does not insert a duplicate header for consecutive same-iteration siblings", () => {
		const items = buildRailItems([makeNode("step-1", 1, 0), makeNode("step-2", 1, 0), makeNode("step-3", 1, 0)]);
		const headers = items.filter((i) => i.kind === "iteration-header");
		expect(headers).toHaveLength(1); // only the boundary into iter 0
		expect((headers[0] as { iterIndex: number }).iterIndex).toBe(0);
	});

	it("invalidates deeper memo when transitioning to a shallower depth (nested forEach scope reset)", () => {
		// outer forEach iter 0, inner forEach inside iter 0 with iter 0+1,
		// outer iter 1 — outer iter 1 must get its own header even though
		// the most recent iterationIndex seen at *some depth* was 1.
		const items = buildRailItems([
			makeNode("outer-step-iter0", 1, 0),
			makeNode("inner-step-iter0", 2, 0),
			makeNode("inner-step-iter1", 2, 1),
			makeNode("outer-step-iter1", 1, 1),
		]);
		const headers = items.filter((i) => i.kind === "iteration-header") as Array<{
			iterIndex: number;
			depth: number;
		}>;
		// Expected headers in order:
		//   1. depth=1, iter=0 (before outer-step-iter0)
		//   2. depth=2, iter=0 (before inner-step-iter0)
		//   3. depth=2, iter=1 (before inner-step-iter1)
		//   4. depth=1, iter=1 (before outer-step-iter1 — proves the
		//      depth-shallower transition didn't get masked by depth=2's memo)
		expect(headers).toHaveLength(4);
		expect(headers[0]).toMatchObject({ iterIndex: 0, depth: 1 });
		expect(headers[1]).toMatchObject({ iterIndex: 0, depth: 2 });
		expect(headers[2]).toMatchObject({ iterIndex: 1, depth: 2 });
		expect(headers[3]).toMatchObject({ iterIndex: 1, depth: 1 });
	});

	it("emits a fresh header when entering a new depth scope, even if iterationIndex matches an outer scope", () => {
		// Inside iteration 0 of an outer forEach, a tryCatch's inner step
		// inherits iterationIndex=0 (correct — it IS part of iteration 0).
		// We DO emit a header at depth=2 to visually mark "this is the
		// content of iteration 0 at the deeper scope" — sub-iteration
		// context is clearer than no context.
		const items = buildRailItems([
			makeNode("forEach-step", 1, 0),
			makeNode("tryCatch-inner", 2, 0),
			makeNode("forEach-step-iter1", 1, 1),
		]);
		const headers = items.filter((i) => i.kind === "iteration-header") as Array<{
			iterIndex: number;
			depth: number;
		}>;
		// Headers in encounter order:
		//   1. depth=1, iter=0 — outer forEach iter 0 starts
		//   2. depth=2, iter=0 — entering tryCatch.try at the deeper scope
		//      still in iter 0 (header is informational, not a new boundary)
		//   3. depth=1, iter=1 — outer forEach iter 1 (the deeper-depth
		//      memo entry was cleared when we transitioned from depth 2
		//      back to depth 1, so the same iter index 1 doesn't suppress
		//      this header)
		expect(headers).toHaveLength(3);
		expect(headers[0]).toMatchObject({ iterIndex: 0, depth: 1 });
		expect(headers[1]).toMatchObject({ iterIndex: 0, depth: 2 });
		expect(headers[2]).toMatchObject({ iterIndex: 1, depth: 1 });
	});

	it("emits header keys that are stable + unique enough for React reconciliation", () => {
		const items = buildRailItems([
			makeNode("step-iter0", 1, 0),
			makeNode("step-iter1", 1, 1),
			makeNode("step-iter2", 1, 2),
		]);
		const headerKeys = items.filter((i) => i.kind === "iteration-header").map((h) => (h as { key: string }).key);
		expect(new Set(headerKeys).size).toBe(headerKeys.length);
	});
});
