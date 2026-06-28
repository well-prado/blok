import { describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../workflow/WorkflowNormalizer";

const step = (id: string) => ({ id, use: "noop", inputs: {} });

const workflow = (steps: unknown[]) => ({
	name: "foreach-scope-test",
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/foreach-scope-test" } },
	steps,
});

describe("WorkflowNormalizer forEach item scope guard", () => {
	it("rejects `as` colliding with a sibling step id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					step("item"),
					{
						id: "each",
						forEach: {
							in: "$.req.body.items",
							as: "item",
							do: [step("process")],
						},
					},
				]),
			),
		).toThrowError(/forEach state key "item" at steps\[1\]\.forEach\.as.*step id "item" at steps\[0\]/);
	});

	it("rejects `as + Index` colliding with a sibling step id", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					step("xIndex"),
					{
						id: "each",
						forEach: {
							in: "$.req.body.items",
							as: "x",
							do: [step("process")],
						},
					},
				]),
			),
		).toThrowError(/forEach state key "xIndex" at steps\[1\]\.forEach\.as \+ "Index".*step id "xIndex"/);
	});

	it("allows non-colliding forEach state keys", () => {
		const normalized = normalizeWorkflow(
			workflow([
				step("load"),
				{
					id: "each",
					forEach: {
						in: "$.req.body.items",
						as: "item",
						do: [step("process")],
					},
				},
			]),
		);

		expect(normalized.steps).toHaveLength(2);
	});

	it("rejects nested forEach aliases that collide with an outer alias", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{
						id: "outer",
						forEach: {
							in: "$.req.body.rows",
							as: "row",
							do: [
								{
									id: "inner",
									forEach: {
										in: "$.state.row.items",
										as: "row",
										do: [step("process")],
									},
								},
							],
						},
					},
				]),
			),
		).toThrowError(
			/forEach state key "row" at steps\[0\]\.forEach\.do\[0\]\.forEach\.as.*surrounding forEach state key at steps\[0\]\.forEach\.as/,
		);
	});

	it("rejects collisions even when the step id is in a mutually-exclusive arm", () => {
		expect(() =>
			normalizeWorkflow(
				workflow([
					{
						id: "route",
						branch: {
							when: "ctx.request.method === 'POST'",
							then: [
								{
									id: "each",
									forEach: {
										in: "$.req.body.items",
										as: "handle",
										do: [step("process")],
									},
								},
							],
							else: [step("handle")],
						},
					},
				]),
			),
		).toThrowError(/forEach state key "handle".*collides with step id "handle"/);
	});
});
