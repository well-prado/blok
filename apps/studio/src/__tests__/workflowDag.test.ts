import {
	type DagEdge,
	type DagNode,
	type DagNodeKind,
	type WorkflowDag,
	buildWorkflowDag,
	classifyStep,
} from "@/lib/workflowDag";
import { describe, expect, it } from "vitest";

// === Helpers ===

function nodeIds(dag: WorkflowDag, kind: DagNodeKind): string[] {
	return dag.nodes.filter((n) => n.data.kind === kind).map((n) => n.id);
}

function findNode(dag: WorkflowDag, predicate: (n: DagNode) => boolean): DagNode | undefined {
	return dag.nodes.find(predicate);
}

function edgesFrom(dag: WorkflowDag, source: string): DagEdge[] {
	return dag.edges.filter((e) => e.source === source);
}

function edgesTo(dag: WorkflowDag, target: string): DagEdge[] {
	return dag.edges.filter((e) => e.target === target);
}

function hasEdge(dag: WorkflowDag, source: string, target: string): boolean {
	return dag.edges.some((e) => e.source === source && e.target === target);
}

function idByLabel(dag: WorkflowDag, label: string): string {
	const node = findNode(dag, (n) => n.data.label === label);
	if (!node) throw new Error(`missing node ${label}`);
	return node.id;
}

// === classifyStep ===

describe("classifyStep", () => {
	it("classifies regular steps without a kind-specific field", () => {
		expect(classifyStep({ id: "x", use: "@blokjs/respond" })).toBe("regular");
	});

	it("classifies a branch step by the `branch` object field", () => {
		expect(classifyStep({ id: "x", branch: { when: "true", then: [] } })).toBe("branch");
	});

	it("classifies a subworkflow step by `subworkflow: <string>`", () => {
		expect(classifyStep({ id: "x", subworkflow: "child" })).toBe("subworkflow");
	});

	it("does NOT confuse `wait: true/false` (subworkflow flag) with the wait step", () => {
		// V2SubworkflowStep has a `wait: boolean` field; only an OBJECT
		// `wait: { for, until }` is the wait step kind.
		expect(classifyStep({ id: "x", subworkflow: "child", wait: false })).toBe("subworkflow");
	});

	it("classifies a wait step by `wait: { for | until }`", () => {
		expect(classifyStep({ id: "x", wait: { for: "1h" } })).toBe("wait");
		expect(classifyStep({ id: "x", wait: { until: "2026-01-01" } })).toBe("wait");
	});

	it("classifies forEach / loop / switch / tryCatch by their field", () => {
		expect(classifyStep({ id: "x", forEach: { in: [], as: "i", do: [] } })).toBe("forEach");
		expect(classifyStep({ id: "x", loop: { while: "true", do: [] } })).toBe("loop");
		expect(classifyStep({ id: "x", switch: { on: 1, cases: [] } })).toBe("switch");
		expect(classifyStep({ id: "x", tryCatch: { try: [], catch: [] } })).toBe("tryCatch");
	});

	it("falls back to regular for non-objects", () => {
		expect(classifyStep(null)).toBe("regular");
		expect(classifyStep("string")).toBe("regular");
		expect(classifyStep(42)).toBe("regular");
		expect(classifyStep([])).toBe("regular");
	});
});

// === buildWorkflowDag — empty / malformed inputs ===

describe("buildWorkflowDag · trivial cases", () => {
	it("always emits a trigger and an end node, even for empty input", () => {
		const dag = buildWorkflowDag({});
		expect(dag.nodes.length).toBe(2);
		expect(nodeIds(dag, "trigger")).toHaveLength(1);
		expect(nodeIds(dag, "end")).toHaveLength(1);
		// Single edge trigger → end.
		expect(dag.edges).toHaveLength(1);
	});

	it("treats null/undefined definition as empty", () => {
		expect(buildWorkflowDag(null).nodes).toHaveLength(2);
		expect(buildWorkflowDag(undefined).nodes).toHaveLength(2);
	});

	it("renders a placeholder for non-object steps without crashing", () => {
		const dag = buildWorkflowDag({ steps: [null, "string-step"] });
		// Two placeholder nodes + trigger + end = 4.
		expect(dag.nodes.length).toBe(4);
		// All non-trigger / non-end / non-merge nodes are 'regular' fallbacks.
		expect(nodeIds(dag, "regular")).toHaveLength(2);
	});
});

// === buildWorkflowDag — trigger summarization ===

describe("buildWorkflowDag · trigger summarization", () => {
	it("summarizes an HTTP trigger with method + path", () => {
		const dag = buildWorkflowDag({ trigger: { http: { method: "POST", path: "/api/users" } } });
		const trigger = findNode(dag, (n) => n.data.kind === "trigger");
		expect(trigger?.data.label).toBe("HTTP · POST");
		expect(trigger?.data.sublabel).toBe("/api/users");
	});

	it("defaults HTTP method to ANY when omitted", () => {
		const dag = buildWorkflowDag({ trigger: { http: { path: "/" } } });
		const trigger = findNode(dag, (n) => n.data.kind === "trigger");
		expect(trigger?.data.label).toBe("HTTP · ANY");
	});

	it("summarizes worker / cron / webhook / grpc triggers", () => {
		const worker = buildWorkflowDag({ trigger: { worker: { queue: "jobs" } } });
		expect(findNode(worker, (n) => n.data.kind === "trigger")?.data.label).toBe("Worker");

		const cron = buildWorkflowDag({ trigger: { cron: { schedule: "*/5 * * * *" } } });
		expect(findNode(cron, (n) => n.data.kind === "trigger")?.data.sublabel).toBe("*/5 * * * *");

		const grpc = buildWorkflowDag({ trigger: { grpc: { service: "Users", method: "Get" } } });
		expect(findNode(grpc, (n) => n.data.kind === "trigger")?.data.sublabel).toBe("Users.Get");
	});
});

// === Regular step + chaining ===

describe("buildWorkflowDag · regular steps", () => {
	it("chains a single regular step between trigger and end", () => {
		const dag = buildWorkflowDag({
			steps: [{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "x" } }],
		});
		const trigger = nodeIds(dag, "trigger")[0]!;
		const end = nodeIds(dag, "end")[0]!;
		const fetch = nodeIds(dag, "regular")[0]!;
		expect(hasEdge(dag, trigger, fetch)).toBe(true);
		expect(hasEdge(dag, fetch, end)).toBe(true);
	});

	it("chains multiple regular steps linearly", () => {
		const dag = buildWorkflowDag({
			steps: [
				{ id: "a", use: "n" },
				{ id: "b", use: "n" },
				{ id: "c", use: "n" },
			],
		});
		const regulars = dag.nodes.filter((n) => n.data.kind === "regular");
		expect(regulars).toHaveLength(3);
		// Each regular step exits to the next; the last exits to end.
		const labels = regulars.map((n) => n.data.label);
		expect(labels).toEqual(["a", "b", "c"]);
		expect(hasEdge(dag, regulars[0]!.id, regulars[1]!.id)).toBe(true);
		expect(hasEdge(dag, regulars[1]!.id, regulars[2]!.id)).toBe(true);
	});

	it("preserves the step id, use ref, and runtime in node meta", () => {
		const dag = buildWorkflowDag({
			steps: [{ id: "fetch", use: "@blokjs/api-call", runtime: "nodejs" }],
		});
		const fetch = findNode(dag, (n) => n.data.kind === "regular");
		expect(fetch?.data.label).toBe("fetch");
		expect(fetch?.data.sublabel).toBe("@blokjs/api-call");
		expect(fetch?.data.meta?.nodeRef).toBe("@blokjs/api-call");
		expect(fetch?.data.meta?.runtime).toBe("nodejs");
	});
});

// === Stable ids ===

describe("buildWorkflowDag · stable node ids", () => {
	const base = {
		steps: [
			{ id: "alpha", use: "n" },
			{ id: "beta", use: "n" },
			{ id: "gamma", use: "n" },
		],
	};

	it("keeps unrelated step ids stable across insert, delete, and reorder", () => {
		const before = buildWorkflowDag(base);
		const ids = {
			alpha: idByLabel(before, "alpha"),
			gamma: idByLabel(before, "gamma"),
		};

		const inserted = buildWorkflowDag({ steps: [{ id: "front", use: "n" }, ...base.steps] });
		expect(idByLabel(inserted, "alpha")).toBe(ids.alpha);
		expect(idByLabel(inserted, "gamma")).toBe(ids.gamma);

		const deleted = buildWorkflowDag({ steps: [base.steps[0], base.steps[2]] });
		expect(idByLabel(deleted, "alpha")).toBe(ids.alpha);
		expect(idByLabel(deleted, "gamma")).toBe(ids.gamma);

		const reordered = buildWorkflowDag({ steps: [base.steps[2], base.steps[0], base.steps[1]] });
		expect(idByLabel(reordered, "alpha")).toBe(ids.alpha);
		expect(idByLabel(reordered, "gamma")).toBe(ids.gamma);
	});

	it("keeps id-less step ids stable for the same workflow", () => {
		const def = { steps: [{ use: "first" }, { use: "second" }] };
		expect(buildWorkflowDag(def).nodes.map((n) => n.id)).toEqual(buildWorkflowDag(def).nodes.map((n) => n.id));
	});

	it("keeps synthetic ids globally unique in nested control flow", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "route",
					branch: {
						when: "true",
						then: [
							{
								id: "fan",
								forEach: {
									in: "$.state.items",
									as: "item",
									do: [
										{
											id: "safe",
											tryCatch: {
												try: [{ id: "risky", use: "n" }],
												catch: [{ id: "recover", use: "n" }],
												finally: [{ id: "cleanup", use: "n" }],
											},
										},
									],
								},
							},
						],
						else: [
							{
								id: "fallback-safe",
								tryCatch: {
									try: [{ id: "fallback-risky", use: "n" }],
									catch: [{ id: "fallback-recover", use: "n" }],
								},
							},
						],
					},
				},
			],
		});
		expect(new Set(dag.nodes.map((n) => n.id)).size).toBe(dag.nodes.length);
	});
});

// === Branch ===

describe("buildWorkflowDag · branch", () => {
	const def = {
		steps: [
			{
				id: "route",
				branch: {
					when: "$.req.method === 'POST'",
					then: [{ id: "create", use: "@blokjs/api-call" }],
					else: [{ id: "read", use: "@blokjs/api-call" }],
				},
			},
			{ id: "respond", use: "@blokjs/respond" },
		],
	};

	it("emits a branch decision and a merge that joins both arms", () => {
		const dag = buildWorkflowDag(def);
		const decision = nodeIds(dag, "branch")[0]!;
		const merge = nodeIds(dag, "merge")[0]!;
		const create = findNode(dag, (n) => n.data.label === "create")!;
		const read = findNode(dag, (n) => n.data.label === "read")!;
		const respond = findNode(dag, (n) => n.data.label === "respond")!;
		// Decision → then-first AND else-first.
		expect(hasEdge(dag, decision, create.id)).toBe(true);
		expect(hasEdge(dag, decision, read.id)).toBe(true);
		// Both arms → merge.
		expect(hasEdge(dag, create.id, merge)).toBe(true);
		expect(hasEdge(dag, read.id, merge)).toBe(true);
		// Sibling step continues from merge.
		expect(hasEdge(dag, merge, respond.id)).toBe(true);
	});

	it("labels the `then` and `else` entry edges + dashes the else path", () => {
		const dag = buildWorkflowDag(def);
		const decision = nodeIds(dag, "branch")[0]!;
		const outgoing = edgesFrom(dag, decision);
		const thenEdge = outgoing.find((e) => e.label === "then");
		const elseEdge = outgoing.find((e) => e.label === "else");
		expect(thenEdge).toBeDefined();
		expect(elseEdge).toBeDefined();
		expect(elseEdge?.style).toBe("dashed");
	});

	it("draws a direct dashed edge to merge when there's no else arm", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "route",
					branch: {
						when: "x",
						then: [{ id: "a", use: "n" }],
					},
				},
			],
		});
		const decision = nodeIds(dag, "branch")[0]!;
		const merge = nodeIds(dag, "merge")[0]!;
		const elseDirect = dag.edges.find((e) => e.source === decision && e.target === merge);
		expect(elseDirect).toBeDefined();
		expect(elseDirect?.style).toBe("dashed");
		expect(elseDirect?.label).toBe("else");
	});

	it("captures the `when` expression on the branch node sublabel", () => {
		const dag = buildWorkflowDag(def);
		const decision = findNode(dag, (n) => n.data.kind === "branch")!;
		expect(decision.data.sublabel).toContain("when");
		expect(decision.data.meta?.expression).toBe("$.req.method === 'POST'");
	});
});

// === Switch ===

describe("buildWorkflowDag · switch", () => {
	it("creates one labelled outgoing edge per case + default + merge", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "kind",
					switch: {
						on: "$.req.body.kind",
						cases: [
							{ when: "a", do: [{ id: "case-a", use: "n" }] },
							{ when: "b", do: [{ id: "case-b", use: "n" }] },
						],
						default: [{ id: "fallback", use: "n" }],
					},
				},
			],
		});
		const switchId = nodeIds(dag, "switch")[0]!;
		const merge = nodeIds(dag, "merge")[0]!;
		const outgoing = edgesFrom(dag, switchId);
		// 2 cases + 1 default = 3 outgoing labelled edges.
		expect(outgoing.length).toBe(3);
		const caseLabels = outgoing.map((e) => e.label);
		expect(caseLabels).toContain("when a");
		expect(caseLabels).toContain("when b");
		expect(caseLabels).toContain("default");
		// Each case head → merge eventually.
		const caseA = findNode(dag, (n) => n.data.label === "case-a")!;
		expect(hasEdge(dag, caseA.id, merge)).toBe(true);
	});

	it("adds a dashed default-stub edge when there's no default arm", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "kind",
					switch: {
						on: "x",
						cases: [{ when: "a", do: [{ id: "a", use: "n" }] }],
					},
				},
			],
		});
		const switchId = nodeIds(dag, "switch")[0]!;
		const merge = nodeIds(dag, "merge")[0]!;
		const stub = dag.edges.find((e) => e.source === switchId && e.target === merge && e.label === "default");
		expect(stub).toBeDefined();
		expect(stub?.style).toBe("dashed");
	});
});

// === ForEach + Loop ===

describe("buildWorkflowDag · forEach / loop", () => {
	it("emits a forEach header with a back-edge from the body's last step", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "fan-out",
					forEach: {
						in: "$.state.items",
						as: "item",
						mode: "parallel",
						concurrency: 5,
						do: [{ id: "process", use: "n" }],
					},
				},
				{ id: "after", use: "n" },
			],
		});
		const header = findNode(dag, (n) => n.data.kind === "forEach")!;
		const process = findNode(dag, (n) => n.data.label === "process")!;
		const after = findNode(dag, (n) => n.data.label === "after")!;

		// Header → body
		expect(hasEdge(dag, header.id, process.id)).toBe(true);
		// Body's last step has a back-edge to the header.
		const backEdge = dag.edges.find((e) => e.source === process.id && e.target === header.id);
		expect(backEdge?.backEdge).toBe(true);
		expect(backEdge?.style).toBe("dotted");
		// Header also exits down to the next sibling.
		expect(hasEdge(dag, header.id, after.id)).toBe(true);
		// Metadata reflects mode + concurrency.
		expect(header.data.meta?.mode).toBe("parallel");
		expect(header.data.meta?.concurrency).toBe(5);
	});

	it("emits a loop header with a `while` sublabel + back-edge", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "until-empty",
					loop: { while: "$.state.queue.length > 0", maxIterations: 100, do: [{ id: "pop", use: "n" }] },
				},
			],
		});
		const header = findNode(dag, (n) => n.data.kind === "loop")!;
		expect(header.data.sublabel).toContain("while");
		expect(header.data.meta?.maxIterations).toBe(100);
		const pop = findNode(dag, (n) => n.data.label === "pop")!;
		const backEdge = dag.edges.find((e) => e.source === pop.id && e.target === header.id);
		expect(backEdge?.backEdge).toBe(true);
	});

	it("handles a forEach with an empty body (header only, no back-edge)", () => {
		const dag = buildWorkflowDag({
			steps: [{ id: "fan", forEach: { in: [], as: "i", do: [] } }],
		});
		const header = findNode(dag, (n) => n.data.kind === "forEach")!;
		const backEdge = dag.edges.find((e) => e.target === header.id && e.backEdge);
		expect(backEdge).toBeUndefined();
	});
});

// === TryCatch ===

describe("buildWorkflowDag · tryCatch", () => {
	it("emits parallel try / catch lanes joined at a merge", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "safe",
					tryCatch: {
						try: [{ id: "risky", use: "n" }],
						catch: [{ id: "handle", use: "n" }],
					},
				},
			],
		});
		const tryEnter = nodeIds(dag, "tryEnter")[0]!;
		const catchEnter = nodeIds(dag, "catchEnter")[0]!;
		const merge = nodeIds(dag, "merge")[0]!;
		const risky = findNode(dag, (n) => n.data.label === "risky")!;
		const handle = findNode(dag, (n) => n.data.label === "handle")!;

		// Sequential try-body
		expect(hasEdge(dag, tryEnter, risky.id)).toBe(true);
		expect(hasEdge(dag, risky.id, merge)).toBe(true);

		// Catch path: dashed from try-enter, then sequential
		const throwEdge = dag.edges.find((e) => e.source === tryEnter && e.target === catchEnter);
		expect(throwEdge?.style).toBe("dashed");
		expect(throwEdge?.label).toBe("throws");
		expect(hasEdge(dag, catchEnter, handle.id)).toBe(true);
		// Catch-body exit lands on merge with dashed style.
		const catchToMerge = dag.edges.find((e) => e.source === handle.id && e.target === merge);
		expect(catchToMerge?.style).toBe("dashed");
	});

	it("emits a finally lane after the merge when present", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "safe",
					tryCatch: {
						try: [{ id: "risky", use: "n" }],
						catch: [{ id: "handle", use: "n" }],
						finally: [{ id: "cleanup", use: "n" }],
					},
				},
			],
		});
		const merge = nodeIds(dag, "merge")[0]!;
		const finallyEnter = nodeIds(dag, "finallyEnter")[0]!;
		const cleanup = findNode(dag, (n) => n.data.label === "cleanup")!;
		const end = nodeIds(dag, "end")[0]!;
		expect(hasEdge(dag, merge, finallyEnter)).toBe(true);
		expect(hasEdge(dag, finallyEnter, cleanup.id)).toBe(true);
		expect(hasEdge(dag, cleanup.id, end)).toBe(true);
	});
});

// === Subworkflow ===

describe("buildWorkflowDag · subworkflow", () => {
	it("emits a subworkflow node with the target in the sublabel", () => {
		const dag = buildWorkflowDag({
			steps: [{ id: "dispatch", subworkflow: "send-receipt", inputs: { x: 1 } }],
		});
		const sw = findNode(dag, (n) => n.data.kind === "subworkflow")!;
		expect(sw.data.label).toBe("dispatch");
		expect(sw.data.sublabel).toContain("send-receipt");
		expect(sw.data.meta?.expression).toBe("send-receipt");
	});

	it("flags async (wait: false) dispatches in the sublabel", () => {
		const dag = buildWorkflowDag({
			steps: [{ id: "dispatch", subworkflow: "background-job", wait: false }],
		});
		const sw = findNode(dag, (n) => n.data.kind === "subworkflow")!;
		expect(sw.data.sublabel).toContain("async");
		expect(sw.data.meta?.wait).toBe(false);
	});

	it("captures the allowList for polymorphic dispatch", () => {
		const dag = buildWorkflowDag({
			steps: [
				{
					id: "router",
					subworkflow: "$.req.body.kind",
					allowList: ["handler.payment", "handler.shipping"],
				},
			],
		});
		const sw = findNode(dag, (n) => n.data.kind === "subworkflow")!;
		expect(sw.data.meta?.allowList).toEqual(["handler.payment", "handler.shipping"]);
	});
});

// === Wait ===

describe("buildWorkflowDag · wait", () => {
	it("renders a `wait` node with the duration / deadline", () => {
		const dag = buildWorkflowDag({
			steps: [{ id: "pause", wait: { for: "1h" } }],
		});
		const node = findNode(dag, (n) => n.data.kind === "wait")!;
		expect(node.data.label).toBe("pause");
		expect(node.data.sublabel).toContain("1h");
	});
});

// === Complex composition (smoke test) ===

describe("buildWorkflowDag · composite workflow smoke test", () => {
	it("renders branch → forEach → tryCatch → respond without crashing", () => {
		const dag = buildWorkflowDag({
			name: "complex",
			trigger: { http: { method: "POST", path: "/api/orders" } },
			steps: [
				{
					id: "validate",
					branch: {
						when: "$.req.body.items.length > 0",
						then: [
							{
								id: "fan",
								forEach: {
									in: "$.req.body.items",
									as: "item",
									do: [
										{
											id: "process",
											tryCatch: {
												try: [{ id: "charge", use: "@blokjs/api-call" }],
												catch: [{ id: "refund", use: "@blokjs/api-call" }],
												finally: [{ id: "log", use: "@blokjs/api-call" }],
											},
										},
									],
								},
							},
						],
						else: [{ id: "bad-request", use: "@blokjs/respond" }],
					},
				},
				{ id: "respond", use: "@blokjs/respond" },
			],
		});

		// Should include every step kind we emitted.
		expect(nodeIds(dag, "trigger").length).toBe(1);
		expect(nodeIds(dag, "branch").length).toBe(1);
		expect(nodeIds(dag, "forEach").length).toBe(1);
		expect(nodeIds(dag, "tryEnter").length).toBe(1);
		expect(nodeIds(dag, "catchEnter").length).toBe(1);
		expect(nodeIds(dag, "finallyEnter").length).toBe(1);
		expect(nodeIds(dag, "end").length).toBe(1);

		// Every edge has unique id + valid endpoints.
		const ids = new Set(dag.edges.map((e) => e.id));
		expect(ids.size).toBe(dag.edges.length);
		const nodeIdSet = new Set(dag.nodes.map((n) => n.id));
		for (const e of dag.edges) {
			expect(nodeIdSet.has(e.source)).toBe(true);
			expect(nodeIdSet.has(e.target)).toBe(true);
		}

		// Sibling step `respond` must be reachable (trigger eventually
		// reaches the end via the final respond step).
		const trigger = nodeIds(dag, "trigger")[0]!;
		const end = nodeIds(dag, "end")[0]!;
		expect(edgesFrom(dag, trigger).length).toBeGreaterThan(0);
		expect(edgesTo(dag, end).length).toBeGreaterThan(0);
	});
});
