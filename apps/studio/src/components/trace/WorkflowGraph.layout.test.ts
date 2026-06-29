import { describe, expect, it } from "vitest";

import type { DagNode } from "@/lib/workflowDag";
import { layoutDag, pinnedPosition } from "./WorkflowGraph";

/**
 * Inline-layout seed/pin + orphan tolerance (#410/#411).
 *
 * Resolution rule under test: a persisted `ui:{x,y}` on a REAL step
 * (one with `meta.stepId`) both SEEDS dagre and PINS the rendered node —
 * the pin overrides dagre's computed position so a structural edit
 * (which re-runs dagre) never snaps the node back. Synthetic nodes
 * (trigger/end/merge/…) have no stepId and always auto-layout. A stale,
 * missing, or non-numeric ui degrades silently to dagre.
 *
 * Drag is out of scope here — the canvas is read-only (`nodesDraggable=
 * false`), so "persisted ui always wins" is the whole deterministic rule.
 */

function node(id: string, stepId: string | undefined, ui?: unknown): DagNode {
	return {
		id,
		data: {
			kind: "regular",
			label: id,
			meta: stepId === undefined ? { raw: ui === undefined ? {} : { ui } } : { stepId, raw: { id: stepId, ui } },
		},
	};
}

function findById(nodes: { id: string; position: { x: number; y: number } }[], id: string) {
	const found = nodes.find((n) => n.id.includes(id));
	if (!found) throw new Error(`node ${id} not found in [${nodes.map((n) => n.id).join(", ")}]`);
	return found;
}

describe("pinnedPosition", () => {
	it("returns {x,y} for a real step with numeric ui", () => {
		expect(pinnedPosition(node("step-a", "a", { x: 123, y: 456 }))).toEqual({ x: 123, y: 456 });
	});

	it("ignores synthetic nodes (no stepId) even when raw carries a ui", () => {
		const synthetic: DagNode = {
			id: "merge-x",
			// raw with a valid ui, but NO stepId → must stay auto-layout.
			data: { kind: "merge", label: "", meta: { raw: { ui: { x: 1, y: 2 } } } },
		};
		expect(pinnedPosition(synthetic)).toBeUndefined();
	});

	it("ignores missing ui", () => {
		expect(pinnedPosition(node("step-a", "a"))).toBeUndefined();
	});

	it("ignores non-numeric / NaN / partial ui", () => {
		expect(pinnedPosition(node("step-a", "a", { x: "1", y: 2 }))).toBeUndefined();
		expect(pinnedPosition(node("step-a", "a", { x: 1 }))).toBeUndefined();
		expect(pinnedPosition(node("step-a", "a", { x: Number.NaN, y: 2 }))).toBeUndefined();
	});
});

describe("layoutDag seed + pin", () => {
	const PINNED = { x: 777, y: 888 };

	const definition = (extraUpstream = false) => ({
		trigger: { http: { method: "POST", path: "/p" } },
		steps: [
			...(extraUpstream ? [{ id: "inserted", use: "@blokjs/respond" }] : []),
			{ id: "pinned", use: "@blokjs/respond", ui: PINNED },
			{ id: "orphan", use: "@blokjs/respond" },
		],
	});

	// (a) a step with ui:{x,y} lands exactly at that position.
	it("pins a step with ui to its exact position", () => {
		const { nodes } = layoutDag(definition());
		expect(findById(nodes, "pinned").position).toEqual(PINNED);
	});

	// (b) an orphan step (no ui) gets a non-trivial auto position.
	it("auto-lays-out an orphan step (no ui)", () => {
		const { nodes } = layoutDag(definition());
		const orphan = findById(nodes, "orphan");
		// dagre stacks TB; the orphan sits below the trigger → non-zero y.
		expect(orphan.position).not.toEqual(PINNED);
		expect(orphan.position.y).toBeGreaterThan(0);
	});

	// (b') synthetic nodes always auto-layout.
	it("auto-lays-out synthetic nodes (trigger/end have no stepId)", () => {
		const { nodes } = layoutDag(definition());
		const end = findById(nodes, "end-");
		expect(end.position).not.toEqual(PINNED);
	});

	// (#411 attack surface) the pinned node survives a dagre re-layout
	// triggered by inserting an UPSTREAM step — proves PIN, not just seed.
	it("keeps the pinned node fixed across a structural edit (dagre re-run)", () => {
		const before = findById(layoutDag(definition(false)).nodes, "pinned").position;
		const after = findById(layoutDag(definition(true)).nodes, "pinned").position;
		expect(before).toEqual(PINNED);
		expect(after).toEqual(PINNED); // unchanged despite the inserted upstream step
	});

	// (#411) deterministic: same definition → same positions every call.
	it("is deterministic — persisted ui always wins (no ephemeral drag state)", () => {
		const a = layoutDag(definition()).nodes.map((n) => [n.id, n.position] as const);
		const b = layoutDag(definition()).nodes.map((n) => [n.id, n.position] as const);
		expect(a).toEqual(b);
	});

	// (c) a ui on a deleted / missing step is ignored without throwing.
	it("tolerates a stale ui key (deleted step) — no crash, auto-layout", () => {
		const stale = {
			trigger: { http: { method: "GET" } },
			steps: [{ id: "survivor", use: "@blokjs/respond" }],
			// 'ghost' carried a ui once but the step is gone — there is simply
			// no DagNode to match, so nothing pins.
		};
		expect(() => layoutDag(stale)).not.toThrow();
		const { nodes } = layoutDag(stale);
		expect(findById(nodes, "survivor").position).not.toEqual(PINNED);
	});

	// (c') garbage / empty ui degrades to auto-layout, no throw.
	it("tolerates an empty workflow and a garbage ui shape", () => {
		expect(() => layoutDag({})).not.toThrow();
		expect(() =>
			layoutDag({ trigger: {}, steps: [{ id: "s", use: "@blokjs/respond", ui: "not-an-object" }] }),
		).not.toThrow();
		const { nodes } = layoutDag({ trigger: {}, steps: [{ id: "s", use: "@blokjs/respond", ui: { x: "bad" } }] });
		expect(findById(nodes, "step-s").position).not.toEqual(PINNED);
	});
});
