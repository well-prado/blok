import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MissingExplicitPathError,
	RouteCollisionError,
	buildRouteTable,
	scorePathSpecificity,
} from "../../src/runner/WorkflowRouter";
import type { ScannedWorkflow } from "../../src/runner/scanWorkflows";

/**
 * Build a ScannedWorkflow fixture. `explicitPath` defaults to
 * `defaultPath` so the bulk of these tests don't need to repeat
 * themselves — v0.4 makes explicit paths required, so most tests
 * pretend the workflow already declared its path. The "no explicit
 * path" branch is exercised by dedicated tests below (the
 * "explicit-path-only routing (v0.4+)" describe block).
 */
function scanned(opts: {
	source: string;
	defaultPath: string;
	method?: string;
	explicitPath?: string | null;
	name?: string;
	kind?: "ts" | "json";
}): ScannedWorkflow {
	const trigger: Record<string, unknown> = {
		http: { method: opts.method ?? "GET" },
	};
	// `null` explicitly opts out (for missing-path tests). Otherwise the
	// helper defaults to defaultPath so authors don't have to repeat it.
	const path = opts.explicitPath === null ? undefined : (opts.explicitPath ?? opts.defaultPath);
	if (path !== undefined) {
		(trigger.http as Record<string, unknown>).path = path;
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
	it("registers a workflow with an explicit path", () => {
		const out = buildRouteTable([scanned({ source: "/wf/users/list.json", defaultPath: "/users/list" })]);
		expect(out).toHaveLength(1);
		expect(out[0].method).toBe("GET");
		expect(out[0].path).toBe("/users/list");
	});

	it("explicit path is the URL — file location is not consulted (v0.4+)", () => {
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

	it("manual registration without explicit path throws MissingExplicitPathError in strict mode", () => {
		expect(() =>
			buildRouteTable(
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
			),
		).toThrow(MissingExplicitPathError);
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

	// =========================================================================
	// v0.4+ explicit-path-only routing
	// =========================================================================

	describe("explicit-path-only routing (v0.4+)", () => {
		const originalEnv = { ...process.env };

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = { ...originalEnv };
		});

		it("strict mode (default): scanned workflow without explicit path throws MissingExplicitPathError", () => {
			process.env.BLOK_ROUTING_LEGACY = undefined as unknown as string;
			expect(() =>
				buildRouteTable([
					scanned({
						source: "/wf/users/list.json",
						defaultPath: "/users/list",
						explicitPath: null, // explicitly opt out
					}),
				]),
			).toThrow(MissingExplicitPathError);
		});

		it("strict mode: error message includes hint, source, and codemod pointer", () => {
			process.env.BLOK_ROUTING_LEGACY = undefined as unknown as string;
			try {
				buildRouteTable([
					scanned({
						source: "/wf/api/v1/items.json",
						defaultPath: "/api/v1/items",
						explicitPath: null,
					}),
				]);
				throw new Error("expected throw");
			} catch (err) {
				expect(err).toBeInstanceOf(MissingExplicitPathError);
				const msg = (err as Error).message;
				expect(msg).toContain("/wf/api/v1/items.json");
				expect(msg).toContain("blokctl migrate paths");
				expect(msg).toContain("BLOK_ROUTING_LEGACY");
			}
		});

		it("legacy mode (BLOK_ROUTING_LEGACY=1): falls back to file-derived URL with deprecation warning", () => {
			process.env.BLOK_ROUTING_LEGACY = "1";
			const warnings: string[] = [];
			const out = buildRouteTable(
				[scanned({ source: "/wf/users/list.json", defaultPath: "/users/list", explicitPath: null })],
				[],
				{ onWarning: (m) => warnings.push(m) },
			);
			expect(out).toHaveLength(1);
			expect(out[0].path).toBe("/users/list");
			expect(warnings.some((w) => w.includes("DEPRECATED") && w.includes("/users/list"))).toBe(true);
		});

		it("legacy mode (BLOK_ROUTING_LEGACY=true): also recognized", () => {
			process.env.BLOK_ROUTING_LEGACY = "true";
			const warnings: string[] = [];
			const out = buildRouteTable([scanned({ source: "/wf/x.json", defaultPath: "/x", explicitPath: null })], [], {
				onWarning: (m) => warnings.push(m),
			});
			expect(out).toHaveLength(1);
			expect(out[0].path).toBe("/x");
			expect(warnings.length).toBeGreaterThan(0);
		});

		it("legacy mode: manual registration without explicit path falls through to catch-all (deprecation warning)", () => {
			process.env.BLOK_ROUTING_LEGACY = "1";
			const warnings: string[] = [];
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
				{ onWarning: (m) => warnings.push(m) },
			);
			expect(out).toEqual([]);
			expect(warnings.some((w) => w.includes("DEPRECATED") && w.includes("legacy"))).toBe(true);
		});

		it("strict mode: manual registration without explicit path throws", () => {
			process.env.BLOK_ROUTING_LEGACY = undefined as unknown as string;
			expect(() =>
				buildRouteTable(
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
				),
			).toThrow(MissingExplicitPathError);
		});

		it("strict mode: workflows WITH explicit path work normally (no warnings)", () => {
			process.env.BLOK_ROUTING_LEGACY = undefined as unknown as string;
			const warnings: string[] = [];
			const out = buildRouteTable(
				[
					scanned({ source: "/a.json", defaultPath: "/a", explicitPath: "/explicit-a" }),
					scanned({ source: "/b.json", defaultPath: "/b", explicitPath: "/explicit-b" }),
				],
				[],
				{ onWarning: (m) => warnings.push(m) },
			);
			expect(out).toHaveLength(2);
			expect(out[0].path).toBe("/explicit-a");
			expect(out[1].path).toBe("/explicit-b");
			expect(warnings.filter((w) => w.includes("DEPRECATED")).length).toBe(0);
		});
	});

	describe("specificity sort (literal beats parameterized)", () => {
		it("registers literal paths before parameterized ones (regardless of scan order)", () => {
			// Scan order: parameterized FIRST (alphabetical accident), literal SECOND.
			// After sort: literal must register first so Hono picks it for an
			// exact match before the catch-all swallows it.
			const out = buildRouteTable([
				scanned({ source: "/wf/mongodb.json", defaultPath: "/x", explicitPath: "/:collection/:id?", method: "ANY" }),
				scanned({ source: "/wf/countries.json", defaultPath: "/c", explicitPath: "/countries" }),
			]);
			expect(out.map((r) => r.path)).toEqual(["/countries", "/:collection/:id?"]);
		});

		it("orders by segment specificity then by length", () => {
			const out = buildRouteTable([
				scanned({ source: "/a.json", defaultPath: "/a", explicitPath: "/:any", method: "ANY" }),
				scanned({ source: "/b.json", defaultPath: "/b", explicitPath: "/users/:id", method: "GET" }),
				scanned({ source: "/c.json", defaultPath: "/c", explicitPath: "/users/list" }),
				scanned({ source: "/d.json", defaultPath: "/d", explicitPath: "/health" }),
			]);
			// Expected: literals first (longer first), then mixed, then bare param
			expect(out.map((r) => r.path)).toEqual(["/users/list", "/users/:id", "/health", "/:any"]);
		});

		it("optional `:param?` ranks lower than required `:param`", () => {
			const out = buildRouteTable([
				scanned({ source: "/a.json", defaultPath: "/a", explicitPath: "/users/:id?", method: "ANY" }),
				scanned({ source: "/b.json", defaultPath: "/b", explicitPath: "/users/:id", method: "GET" }),
			]);
			expect(out.map((r) => r.path)).toEqual(["/users/:id", "/users/:id?"]);
		});

		it("scorePathSpecificity: literal > param > optional param", () => {
			expect(scorePathSpecificity("/users/list")).toBeGreaterThan(scorePathSpecificity("/users/:id"));
			expect(scorePathSpecificity("/users/:id")).toBeGreaterThan(scorePathSpecificity("/users/:id?"));
			expect(scorePathSpecificity("/a/b/c")).toBeGreaterThan(scorePathSpecificity("/a/b"));
		});
	});
});
