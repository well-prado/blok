import { describe, expect, it } from "vitest";
import {
	type InsertTarget,
	connect,
	deleteStep,
	findStepLocation,
	insertStep,
	nextId,
	renameStep,
	reorderStep,
	walkSteps,
} from "./irEditOps";
import { buildWorkflowDag } from "./workflowDag";

// === Deeply-nested fixture (every arm kind, 2-3 levels deep) ===

function fixture() {
	return {
		name: "Edit Ops Fixture",
		version: "1.0.0",
		trigger: { http: { method: "ANY", path: "/edit" } },
		steps: [
			{ id: "top-a", use: "@blokjs/api-call", inputs: { url: "https://x" }, ui: { x: 10, y: 20 } },
			{
				id: "the-branch",
				branch: {
					when: "ctx.req.method === 'POST'",
					then: [
						{ id: "then-1", use: "n", inputs: { v: "js/ctx.state['top-a'].data" } },
						{
							id: "nested-foreach",
							forEach: {
								in: "js/ctx.state.items",
								as: "item",
								do: [{ id: "fe-inner", use: "n", inputs: {} }],
							},
						},
					],
					else: [{ id: "else-1", use: "n", inputs: {} }],
				},
			},
			{
				id: "the-switch",
				switch: {
					on: "js/ctx.req.body.kind",
					cases: [
						{ when: "a", do: [{ id: "case-a-1", use: "n", inputs: {} }] },
						{ when: "b", do: [{ id: "case-b-1", use: "n", inputs: {} }] },
					],
					default: [{ id: "default-1", use: "n", inputs: {} }],
				},
			},
			{
				id: "the-try",
				tryCatch: {
					try: [{ id: "try-1", use: "n", inputs: {} }],
					catch: [{ id: "catch-1", use: "n", inputs: {} }],
					finally: [{ id: "finally-1", use: "n", inputs: {} }],
				},
			},
		],
	};
}

/** Every step id reachable through a buildWorkflowDag pass, in node order. */
function dagStepIds(ir: unknown): string[] {
	return buildWorkflowDag(ir)
		.nodes.map((n) => n.data.meta?.stepId)
		.filter((s): s is string => s !== undefined);
}

describe("walkSteps / findStepLocation", () => {
	it("visits every step in every nested arm", () => {
		const ids: string[] = [];
		walkSteps(fixture(), (step) => {
			if (typeof step.id === "string") ids.push(step.id);
		});
		expect(ids.sort()).toEqual(
			[
				"top-a",
				"the-branch",
				"then-1",
				"nested-foreach",
				"fe-inner",
				"else-1",
				"the-switch",
				"case-a-1",
				"case-b-1",
				"default-1",
				"the-try",
				"try-1",
				"catch-1",
				"finally-1",
			].sort(),
		);
	});

	it("locates a step nested 3 levels deep (forEach inside branch.then)", () => {
		const loc = findStepLocation(fixture(), "fe-inner");
		expect(loc).not.toBeNull();
		expect(loc?.step.id).toBe("fe-inner");
		expect(loc?.index).toBe(0);
	});

	it("returns null for an unknown id", () => {
		expect(findStepLocation(fixture(), "nope")).toBeNull();
	});
});

describe("insertStep — lands in the correct arm, lossless round-trip", () => {
	// `armOf` returns the EXACT live array the step must land in, so the
	// assertion pins the arm structurally (mutating caseIndex handling, or
	// resolving the wrong arm, makes the inserted step miss it → test fails).
	type F = ReturnType<typeof fixture>;
	const arms: {
		name: string;
		target: InsertTarget;
		expectBefore: string;
		armOf: (ir: F) => { id?: string }[];
	}[] = [
		{
			name: "branch.then",
			target: { parentId: "the-branch", arm: "then" },
			expectBefore: "then-1",
			armOf: (ir) => (ir.steps[1] as { branch: { then: { id?: string }[] } }).branch.then,
		},
		{
			name: "switch.cases[1].do",
			target: { parentId: "the-switch", arm: "case", caseIndex: 1 },
			expectBefore: "case-b-1",
			armOf: (ir) => (ir.steps[2] as { switch: { cases: { do: { id?: string }[] }[] } }).switch.cases[1]!.do,
		},
		{
			name: "forEach.do",
			target: { parentId: "nested-foreach", arm: "do" },
			expectBefore: "fe-inner",
			armOf: (ir) =>
				(
					(ir.steps[1] as { branch: { then: { forEach?: { do: { id?: string }[] } }[] } }).branch.then[1]!.forEach as {
						do: { id?: string }[];
					}
				).do,
		},
		{
			name: "tryCatch.catch",
			target: { parentId: "the-try", arm: "catch" },
			expectBefore: "catch-1",
			armOf: (ir) => (ir.steps[3] as { tryCatch: { catch: { id?: string }[] } }).tryCatch.catch,
		},
	];

	for (const { name, target, expectBefore, armOf } of arms) {
		it(`inserts into ${name} and survives a buildWorkflowDag round-trip`, () => {
			const before = fixture();
			const newStep = { id: "inserted", use: "n", inputs: { k: 1 } };
			const after = insertStep(before, target, 0, newStep) as F;

			// input untouched
			expect(JSON.stringify(before)).toBe(JSON.stringify(fixture()));

			// landed in the EXACT target arm, at index 0 (pins arm-targeting)
			expect(armOf(after)[0]?.id).toBe("inserted");

			// new step appears in the dag, and BEFORE the arm's original first step
			const ids = dagStepIds(after);
			expect(ids).toContain("inserted");
			expect(ids.indexOf("inserted")).toBeLessThan(ids.indexOf(expectBefore));

			// every original step still present (nothing dropped or mangled)
			for (const orig of dagStepIds(before)) {
				expect(ids).toContain(orig);
			}
		});
	}

	it("inserts into an empty arm (branch.else created on demand)", () => {
		const before = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [{ id: "b", branch: { when: "ctx.x", then: [{ id: "t", use: "n" }] } }],
		};
		const after = insertStep(before, { parentId: "b", arm: "else" }, 0, { id: "new-else", use: "n" }) as typeof before;
		const elseArm = (after.steps[0] as { branch: { else?: { id: string }[] } }).branch.else;
		expect(elseArm).toEqual([{ id: "new-else", use: "n" }]);
		expect(dagStepIds(after)).toContain("new-else");
	});

	it("preserves inline ui:{x,y} and js/ refs byte-identically through a round-trip", () => {
		const after = insertStep(fixture(), { topLevel: true }, 0, { id: "fresh", use: "n" }) as ReturnType<typeof fixture>;
		const topA = after.steps.find((s) => (s as { id?: string }).id === "top-a");
		expect(topA).toEqual({
			id: "top-a",
			use: "@blokjs/api-call",
			inputs: { url: "https://x" },
			ui: { x: 10, y: 20 },
		});
		// js/ ref string untouched
		const then1 = findStepLocation(after, "then-1")?.step;
		expect(then1?.inputs).toEqual({ v: "js/ctx.state['top-a'].data" });
	});

	// #412 — write-path duplicate-id guard
	it("THROWS when inserting an id that already exists anywhere in the tree (#412)", () => {
		expect(() =>
			insertStep(fixture(), { parentId: "the-branch", arm: "then" }, 0, { id: "case-a-1", use: "n" }),
		).toThrow(/duplicate id/i);
	});

	it("rejects a duplicate id across mutually-exclusive branch arms (#412)", () => {
		// "else-1" lives in branch.else — inserting it into branch.then must throw
		expect(() => insertStep(fixture(), { parentId: "the-branch", arm: "then" }, 0, { id: "else-1", use: "n" })).toThrow(
			/duplicate id/i,
		);
	});

	it("rejects a duplicate between top-level and a nested forEach.do step (#412)", () => {
		expect(() => insertStep(fixture(), { topLevel: true }, 0, { id: "fe-inner", use: "n" })).toThrow(/duplicate id/i);
	});

	it("ALLOWS reusing an id via `as:` alias (not an id collision) (#412 edge case)", () => {
		// `as` matching an existing id is fine — only `id` must be unique.
		expect(() =>
			insertStep(fixture(), { topLevel: true }, 0, { id: "unique-new", as: "top-a", use: "n" }),
		).not.toThrow();
	});
});

describe("deleteStep — removes from owning arm, leaves valid array", () => {
	it("deletes a nested step and leaves the arm a valid array", () => {
		const after = deleteStep(fixture(), "case-b-1") as ReturnType<typeof fixture>;
		expect(findStepLocation(after, "case-b-1")).toBeNull();
		const caseB = (after.steps[2] as { switch: { cases: { do: unknown[] }[] } }).switch.cases[1]!;
		expect(caseB.do).toEqual([]); // empty array, NOT undefined
	});

	it("deletes the only step in an arm without orphaning siblings", () => {
		const before = fixture();
		const after = deleteStep(before, "else-1") as ReturnType<typeof fixture>;
		const elseArm = (after.steps[1] as { branch: { else: unknown[] } }).branch.else;
		expect(elseArm).toEqual([]);
		// untouched siblings survive
		expect(findStepLocation(after, "then-1")).not.toBeNull();
		// input untouched
		expect(JSON.stringify(before)).toBe(JSON.stringify(fixture()));
	});

	it("throws on an unknown id", () => {
		expect(() => deleteStep(fixture(), "nope")).toThrow(/no step with id/i);
	});
});

describe("reorderStep — moves within its arm", () => {
	it("reorders top-level steps and round-trips", () => {
		const after = reorderStep(fixture(), "top-a", 2) as ReturnType<typeof fixture>;
		const topIds = after.steps.map((s) => (s as { id?: string }).id);
		expect(topIds.indexOf("top-a")).toBe(2);
		expect(dagStepIds(after)).toContain("top-a");
	});

	it("reorders within a nested arm (switch.cases[0].do)", () => {
		const before = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [
				{
					id: "sw",
					switch: {
						on: "ctx.x",
						cases: [
							{
								when: "a",
								do: [
									{ id: "x1", use: "n" },
									{ id: "x2", use: "n" },
									{ id: "x3", use: "n" },
								],
							},
						],
					},
				},
			],
		};
		const after = reorderStep(before, "x3", 0) as typeof before;
		const doArm = (after.steps[0] as { switch: { cases: { do: { id: string }[] }[] } }).switch.cases[0]!.do;
		expect(doArm.map((s) => s.id)).toEqual(["x3", "x1", "x2"]);
		// input untouched
		expect(JSON.stringify(before).includes('"x3"')).toBe(true);
	});

	it("throws on an unknown id", () => {
		expect(() => reorderStep(fixture(), "nope", 0)).toThrow(/no step with id/i);
	});
});

describe("nextId — globally unique across nested arms", () => {
	it("never collides with an id in any nested arm", () => {
		const ir = fixture();
		const all: string[] = [];
		walkSteps(ir, (s) => {
			if (typeof s.id === "string") all.push(s.id);
		});
		const id = nextId(ir, "step");
		expect(all).not.toContain(id);
	});

	it("bumps the counter past an existing collision", () => {
		const ir = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [
				{ id: "step-1", use: "n" },
				{ id: "b", branch: { when: "ctx.x", then: [{ id: "step-2", use: "n" }] } },
			],
		};
		expect(nextId(ir, "step")).toBe("step-3");
	});

	it("sanitizes the kind into a safe id base", () => {
		const ir = { name: "W", version: "1.0.0", trigger: {}, steps: [] };
		expect(nextId(ir, "@blokjs/api-call")).toBe("blokjs-api-call-1");
	});
});

describe("connect — rejects cross-arm targets", () => {
	it("allows a connection within the same arm", () => {
		const ir = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [
				{ id: "a", use: "n" },
				{ id: "b", use: "n" },
			],
		};
		expect(() => connect(ir, "a", "b")).not.toThrow();
	});

	it("rejects a connection across branch then/else arms", () => {
		expect(() => connect(fixture(), "then-1", "else-1")).toThrow(/different arms/i);
	});

	it("rejects a connection from top-level into a nested arm", () => {
		expect(() => connect(fixture(), "top-a", "fe-inner")).toThrow(/different arms/i);
	});
});

describe("10 random edit ops preserve untouched steps (#407 property-style)", () => {
	it("survives a sequence of inserts/deletes/reorders with no untouched step mangled", () => {
		let ir: unknown = fixture();
		// A sequence that touches several arms; assert the never-touched
		// `the-try`/`finally-1` chain stays byte-identical throughout.
		const finallyOriginal = JSON.stringify(findStepLocation(ir, "finally-1")?.step);

		ir = insertStep(ir, { parentId: "the-branch", arm: "then" }, 1, { id: "ins-1", use: "n" });
		ir = insertStep(ir, { parentId: "the-switch", arm: "case", caseIndex: 0 }, 0, { id: "ins-2", use: "n" });
		ir = reorderStep(ir, "then-1", 0);
		ir = deleteStep(ir, "ins-2");
		ir = insertStep(ir, { parentId: "the-try", arm: "try" }, 0, { id: "ins-3", use: "n" });
		ir = reorderStep(ir, "case-a-1", 0);
		ir = insertStep(ir, { topLevel: true }, 0, { id: "ins-4", use: "n" });
		ir = deleteStep(ir, "ins-1");
		ir = reorderStep(ir, "the-switch", 0);
		ir = insertStep(ir, { parentId: "nested-foreach", arm: "do" }, 0, { id: "ins-5", use: "n" });

		// untouched finally step is byte-identical
		expect(JSON.stringify(findStepLocation(ir, "finally-1")?.step)).toBe(finallyOriginal);
		// every surviving original id still renders
		const ids = dagStepIds(ir);
		for (const orig of ["top-a", "then-1", "else-1", "case-a-1", "default-1", "try-1", "catch-1", "finally-1"]) {
			expect(ids).toContain(orig);
		}
		// deleted ones are gone
		expect(findStepLocation(ir, "ins-1")).toBeNull();
		expect(findStepLocation(ir, "ins-2")).toBeNull();
	});
});

describe("renameStep — id rewrite + boundary-safe reference propagation (#408/#409)", () => {
	// Fixture with `old` referenced from a downstream input, a loop publishing
	// its counter, sibling ids that share a prefix (`old2`, `oldFoo`), a bracket
	// ref, and a branch.when / loop.while raw condition string.
	function renameFixture() {
		return {
			name: "Rename Fixture",
			version: "1.0.0",
			trigger: { http: { method: "ANY", path: "/r" } },
			steps: [
				{ id: "old", use: "n", inputs: { url: "https://x" } },
				{ id: "old2", use: "n", inputs: {} },
				{ id: "oldFoo", use: "n", inputs: {} },
				{
					id: "downstream",
					use: "n",
					inputs: {
						// dot form with trailing path — must become ctx.state.new.field
						a: "js/ctx.state.old.field",
						// prefix-only siblings — must be LEFT UNCHANGED
						b: "js/ctx.state.old2.x",
						c: "js/ctx.state.oldFoo",
						// bracket form — must become ctx.state["new"]
						d: 'js/ctx.state["old"]',
						// nested object/array deep rewrite
						nested: { deep: ["js/ctx.state.old.items", "literal"] },
					},
				},
				{
					id: "the-loop",
					loop: {
						while: "ctx.state.old.count > 0",
						do: [{ id: "loop-inner", use: "n", inputs: { i: "js/ctx.state.theLoopIndex" } }],
					},
				},
				{
					id: "the-branch",
					branch: {
						when: "ctx.state.old.ok === true",
						then: [{ id: "br-then", use: "n", inputs: {} }],
					},
				},
			],
		};
	}

	// (a) downstream input ref ctx.state.old.field → ctx.state.new.field
	it("propagates a downstream input ref (preserving the trailing path)", () => {
		const after = renameStep(renameFixture(), "old", "new") as ReturnType<typeof renameFixture>;
		expect(findStepLocation(after, "old")).toBeNull();
		expect(findStepLocation(after, "new")).not.toBeNull();
		const ds = findStepLocation(after, "downstream")?.step as { inputs: Record<string, unknown> };
		expect(ds.inputs.a).toBe("js/ctx.state.new.field");
		expect(ds.inputs.d).toBe('js/ctx.state["new"]');
		expect(ds.inputs.nested).toEqual({ deep: ["js/ctx.state.new.items", "literal"] });
	});

	// (b) rename a loop step propagates its counter ctx.state.oldIndex → newIndex
	it("propagates the loop counter <oldId>Index → <newId>Index", () => {
		const ir = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [
				{ id: "theLoop", loop: { while: "true", do: [{ id: "inner", use: "n", inputs: {} }] } },
				{ id: "reader", use: "n", inputs: { i: "js/ctx.state.theLoopIndex" } },
			],
		};
		const after = renameStep(ir, "theLoop", "renamedLoop") as typeof ir;
		const reader = findStepLocation(after, "reader")?.step as { inputs: { i: string } };
		expect(reader.inputs.i).toBe("js/ctx.state.renamedLoopIndex");
	});

	// (c) OVER/UNDER-MATCH guard — prefix siblings left untouched
	it("leaves prefix-sibling refs (old2, oldFoo) UNCHANGED when renaming `old`", () => {
		const after = renameStep(renameFixture(), "old", "new") as ReturnType<typeof renameFixture>;
		const ds = findStepLocation(after, "downstream")?.step as { inputs: Record<string, unknown> };
		expect(ds.inputs.b).toBe("js/ctx.state.old2.x");
		expect(ds.inputs.c).toBe("js/ctx.state.oldFoo");
		// the sibling steps' own ids are untouched too
		expect(findStepLocation(after, "old2")).not.toBeNull();
		expect(findStepLocation(after, "oldFoo")).not.toBeNull();
	});

	// (d) rename inside branch.when / loop.while raw condition strings
	it("rewrites the ref inside branch.when and loop.while conditions", () => {
		const after = renameStep(renameFixture(), "old", "new") as ReturnType<typeof renameFixture>;
		const branch = findStepLocation(after, "the-branch")?.step as { branch: { when: string } };
		const loop = findStepLocation(after, "the-loop")?.step as { loop: { while: string } };
		expect(branch.branch.when).toBe("ctx.state.new.ok === true");
		expect(loop.loop.while).toBe("ctx.state.new.count > 0");
	});

	// (e) bracket form ctx.state["old"] (covered in (a)); single-quote variant here
	it("rewrites both single- and double-quote bracket forms", () => {
		const ir = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [
				{ id: "old", use: "n", inputs: {} },
				{ id: "r", use: "n", inputs: { a: "js/ctx.state['old'].x", b: 'js/ctx.state["old"]' } },
			],
		};
		const after = renameStep(ir, "old", "new") as typeof ir;
		const r = findStepLocation(after, "r")?.step as { inputs: { a: string; b: string } };
		expect(r.inputs.a).toBe("js/ctx.state['new'].x");
		expect(r.inputs.b).toBe('js/ctx.state["new"]');
	});

	// (f) newId collision throws
	it("throws when newId already exists anywhere in the tree", () => {
		expect(() => renameStep(renameFixture(), "old", "old2")).toThrow(/already exists/i);
	});

	it("throws when oldId is not found", () => {
		expect(() => renameStep(renameFixture(), "nope", "x")).toThrow(/no step with id/i);
	});

	// (g) id with a regex metacharacter renames safely
	it("renames an id containing a regex metacharacter (a-b) without over-matching", () => {
		const ir = {
			name: "W",
			version: "1.0.0",
			trigger: { http: { method: "ANY" } },
			steps: [
				{ id: "a-b", use: "n", inputs: {} },
				// `a-b` must match; `axb` must NOT (the `-` is a literal, not a regex range)
				{ id: "axb", use: "n", inputs: {} },
				{ id: "r", use: "n", inputs: { hit: "js/ctx.state.a-b.x", miss: "js/ctx.state.axb.y" } },
			],
		};
		const after = renameStep(ir, "a-b", "c-d") as typeof ir;
		const r = findStepLocation(after, "r")?.step as { inputs: { hit: string; miss: string } };
		expect(r.inputs.hit).toBe("js/ctx.state.c-d.x");
		expect(r.inputs.miss).toBe("js/ctx.state.axb.y");
		expect(findStepLocation(after, "c-d")).not.toBeNull();
	});

	// (h) input not mutated (structuredClone)
	it("does not mutate the input IR", () => {
		const before = renameFixture();
		const snapshot = JSON.stringify(before);
		renameStep(before, "old", "new");
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("rename survives a buildWorkflowDag round-trip", () => {
		const after = renameStep(renameFixture(), "old", "new");
		expect(dagStepIds(after)).toContain("new");
		expect(dagStepIds(after)).not.toContain("old");
	});

	// no-op rename (oldId === newId) is a clean pass-through
	it("returns a clone unchanged when oldId === newId", () => {
		const after = renameStep(renameFixture(), "old", "old") as ReturnType<typeof renameFixture>;
		expect(findStepLocation(after, "old")).not.toBeNull();
	});
});
