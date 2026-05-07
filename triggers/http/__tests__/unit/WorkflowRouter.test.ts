import { describe, expect, it } from "vitest";
import { RouteCollisionError, buildRouteTable } from "../../src/runner/WorkflowRouter";
import type { ScannedWorkflow } from "../../src/runner/scanWorkflows";

function scanned(opts: {
	source: string;
	defaultPath: string;
	method?: string;
	explicitPath?: string;
	name?: string;
	kind?: "ts" | "json";
}): ScannedWorkflow {
	const trigger: Record<string, unknown> = {
		http: { method: opts.method ?? "GET" },
	};
	if (opts.explicitPath) {
		(trigger.http as Record<string, unknown>).path = opts.explicitPath;
	}
	return {
		source: opts.source,
		kind: opts.kind ?? "json",
		defaultPath: opts.defaultPath,
		workflow: {
			name: opts.name ?? "Test",
			version: "1.0.0",
			trigger,
		},
		name: opts.name ?? "Test",
	};
}

describe("buildRouteTable", () => {
	it("uses the default path when no explicit path is set", () => {
		const out = buildRouteTable([scanned({ source: "/wf/users/list.json", defaultPath: "/users/list" })]);
		expect(out).toHaveLength(1);
		expect(out[0].method).toBe("GET");
		expect(out[0].path).toBe("/users/list");
	});

	it("explicit path overrides the file-derived default", () => {
		const out = buildRouteTable([
			scanned({
				source: "/wf/anything.json",
				defaultPath: "/anything",
				explicitPath: "/api/users/:id",
			}),
		]);
		expect(out[0].path).toBe("/api/users/:id");
	});

	it("normalizes method '*' to ANY", () => {
		const out = buildRouteTable([scanned({ source: "/wf/x.json", defaultPath: "/x", method: "*" })]);
		expect(out[0].method).toBe("ANY");
	});

	it("uppercases the method", () => {
		const out = buildRouteTable([scanned({ source: "/wf/x.json", defaultPath: "/x", method: "post" })]);
		expect(out[0].method).toBe("POST");
	});

	it("skips workflows without an http trigger", () => {
		const wf: ScannedWorkflow = {
			source: "/wf/cron.json",
			kind: "json",
			defaultPath: "/cron",
			workflow: {
				name: "C",
				version: "1.0.0",
				trigger: { cron: { schedule: "0 * * * *" } },
			},
			name: "C",
		};
		const out = buildRouteTable([wf]);
		expect(out).toEqual([]);
	});

	it("throws on exact (method, path) duplicate", () => {
		expect(() =>
			buildRouteTable([
				scanned({ source: "/a.json", defaultPath: "/users" }),
				scanned({ source: "/b.json", defaultPath: "/users" }),
			]),
		).toThrow(RouteCollisionError);
	});

	it("throws when ANY shadows a more specific method on the same path", () => {
		expect(() =>
			buildRouteTable([
				scanned({ source: "/get.json", defaultPath: "/x", method: "GET" }),
				scanned({ source: "/any.json", defaultPath: "/x", method: "ANY" }),
			]),
		).toThrow(RouteCollisionError);
	});

	it("throws when a specific method is registered after an ANY on the same path", () => {
		expect(() =>
			buildRouteTable([
				scanned({ source: "/any.json", defaultPath: "/x", method: "ANY" }),
				scanned({ source: "/get.json", defaultPath: "/x", method: "GET" }),
			]),
		).toThrow(RouteCollisionError);
	});

	it("warns on param-vs-literal at the same depth (non-fatal)", () => {
		const warnings: string[] = [];
		const out = buildRouteTable(
			[
				scanned({ source: "/me.json", defaultPath: "/users/me" }),
				scanned({ source: "/byid.json", defaultPath: "/users/:id" }),
			],
			[],
			{ onWarning: (m) => warnings.push(m) },
		);
		expect(out).toHaveLength(2);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toMatch(/param/);
	});

	it("manual registrations contribute when explicit path is set", () => {
		const out = buildRouteTable(
			[],
			[
				{
					key: "legacy",
					workflow: {
						name: "Legacy",
						version: "1.0.0",
						trigger: { http: { method: "GET", path: "/legacy/url" } },
					},
				},
			],
		);
		expect(out).toHaveLength(1);
		expect(out[0].path).toBe("/legacy/url");
	});

	it("manual registrations WITHOUT explicit path are NOT registered (fall through to legacy catch-all)", () => {
		const out = buildRouteTable(
			[],
			[
				{
					key: "legacy",
					workflow: {
						name: "Legacy",
						version: "1.0.0",
						trigger: { http: { method: "GET" } },
					},
				},
			],
		);
		expect(out).toEqual([]);
	});

	it("manual registrations override scanned ones via collision detection", () => {
		// Same (method, path) — second one (manual) collides with the first.
		expect(() =>
			buildRouteTable(
				[scanned({ source: "/scanned.json", defaultPath: "/api/users" })],
				[
					{
						key: "manual",
						workflow: {
							name: "M",
							version: "1.0.0",
							trigger: { http: { method: "GET", path: "/api/users" } },
						},
					},
				],
			),
		).toThrow(RouteCollisionError);
	});

	it("preserves order: scanned first, then manual", () => {
		const out = buildRouteTable(
			[scanned({ source: "/a.json", defaultPath: "/a" }), scanned({ source: "/b.json", defaultPath: "/b" })],
			[
				{
					key: "manual",
					workflow: {
						name: "M",
						version: "1.0.0",
						trigger: { http: { method: "GET", path: "/m" } },
					},
				},
			],
		);
		expect(out.map((r) => r.path)).toEqual(["/a", "/b", "/m"]);
	});
});
