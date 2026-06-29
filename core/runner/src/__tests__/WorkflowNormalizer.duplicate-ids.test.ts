import { describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../workflow/WorkflowNormalizer";

const step = (id: string) => ({ id, use: "noop", inputs: {} });

const workflow = (steps: unknown[]) => ({
	name: "duplicate-id-test",
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/duplicate-id-test" } },
	steps,
});

describe("WorkflowNormalizer duplicate step-id guard", () => {
	it("throws with both branch arm paths when then/else reuse an id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{
						id: "route",
						branch: {
							when: "ctx.request.method === 'POST'",
							then: [step("create")],
							else: [step("create")],
						},
					},
				]),
			),
		).toThrowError(
			/duplicate step id "create" at steps\[0\]\.branch\.else\[0\]; first seen at steps\[0\]\.branch\.then\[0\].*use `as:`/s,
		);
	});

	it("throws when a nested arm reuses a top-level id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					step("shared"),
					{
						id: "route",
						branch: {
							when: "ctx.request.method === 'POST'",
							then: [step("shared")],
						},
					},
				]),
			),
		).toThrowError(/duplicate step id "shared" at steps\[1\]\.branch\.then\[0\]; first seen at steps\[0\]/);
	});

	it("allows distinct ids across mutually-exclusive arms", () => {
		const normalized = normalizeWorkflow(
			workflow([
				{
					id: "route",
					branch: {
						when: "ctx.request.method === 'POST'",
						then: [step("create")],
						else: [step("read")],
					},
				},
			]),
		);

		expect(normalized.steps).toHaveLength(1);
	});

	it("allows case-only differences in ids", () => {
		const normalized = normalizeWorkflow(
			workflow([
				{
					id: "route",
					branch: {
						when: "ctx.request.method === 'POST'",
						then: [step("Run")],
						else: [step("run")],
					},
				},
			]),
		);

		expect(normalized.steps).toHaveLength(1);
	});

	it("allows unique ids that intentionally write the same downstream `as` key", () => {
		const normalized = normalizeWorkflow(
			workflow([
				{
					id: "route",
					branch: {
						when: "ctx.request.method === 'POST'",
						then: [{ ...step("create-via-post"), as: "result" }],
						else: [{ ...step("create-via-get"), as: "result" }],
					},
				},
			]),
		);

		expect(normalized.steps).toHaveLength(1);
		const conditions = normalized.nodes.route.conditions as Array<{ steps: Array<{ as?: string }> }>;
		expect(conditions[0].steps[0].as).toBe("result");
		expect(conditions[1].steps[0].as).toBe("result");
	});

	it("throws when tryCatch try and finally reuse an id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{
						id: "guarded",
						tryCatch: {
							try: [step("cleanup")],
							catch: [step("recover")],
							finally: [step("cleanup")],
						},
					},
				]),
			),
		).toThrowError(
			/duplicate step id "cleanup" at steps\[0\]\.tryCatch\.finally\[0\]; first seen at steps\[0\]\.tryCatch\.try\[0\]/,
		);
	});

	it("throws when a forEach body reuses an outer sibling id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					step("persist"),
					{
						id: "each",
						forEach: {
							in: "$.req.body.items",
							as: "item",
							do: [step("persist")],
						},
					},
				]),
			),
		).toThrowError(/duplicate step id "persist" at steps\[1\]\.forEach\.do\[0\]; first seen at steps\[0\]/);
	});

	it("throws when a loop body reuses an outer sibling id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					step("tick"),
					{
						id: "retry-until-done",
						loop: {
							while: "ctx.state.tick.count < 3",
							do: [step("tick")],
						},
					},
				]),
			),
		).toThrowError(/duplicate step id "tick" at steps\[1\]\.loop\.do\[0\]; first seen at steps\[0\]/);
	});

	it("throws when switch cases reuse an id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{
						id: "route",
						switch: {
							on: "$.req.body.kind",
							cases: [
								{ when: "a", do: [step("handle")] },
								{ when: "b", do: [step("handle")] },
							],
						},
					},
				]),
			),
		).toThrowError(
			/duplicate step id "handle" at steps\[0\]\.switch\.cases\[1\]\.do\[0\]; first seen at steps\[0\]\.switch\.cases\[0\]\.do\[0\]/,
		);
	});

	it("reports the first duplicate when three or more switch arms share an id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{
						id: "route",
						switch: {
							on: "$.req.body.kind",
							cases: [
								{ when: "a", do: [step("handle")] },
								{ when: "b", do: [step("handle-b")] },
								{ when: "c", do: [step("handle")] },
							],
						},
					},
				]),
			),
		).toThrowError(
			/duplicate step id "handle" at steps\[0\]\.switch\.cases\[2\]\.do\[0\]; first seen at steps\[0\]\.switch\.cases\[0\]\.do\[0\]/,
		);
	});

	it("rejects collisions between legacy v1 step names and v2 ids", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{ name: "legacy-run", node: "@blokjs/respond", type: "module", inputs: {} },
					{
						id: "route",
						branch: {
							when: "ctx.request.method === 'POST'",
							then: [step("legacy-run")],
						},
					},
				]),
			),
		).toThrowError(/duplicate step id "legacy-run" at steps\[1\]\.branch\.then\[0\]; first seen at steps\[0\]/);
	});

	it("names deep branch-in-catch-in-forEach paths", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					step("notify"),
					{
						id: "each",
						forEach: {
							in: "$.req.body.items",
							as: "item",
							do: [
								{
									id: "guarded",
									tryCatch: {
										try: [step("work")],
										catch: [
											{
												id: "recover-route",
												branch: {
													when: "ctx.error",
													then: [step("notify")],
												},
											},
										],
									},
								},
							],
						},
					},
				]),
			),
		).toThrowError(
			/duplicate step id "notify" at steps\[1\]\.forEach\.do\[0\]\.tryCatch\.catch\[0\]\.branch\.then\[0\]; first seen at steps\[0\]/,
		);
	});
});
