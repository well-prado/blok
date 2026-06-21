import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MissingExplicitPathError,
	type RouteCollision,
	RouteCollisionError,
	buildRouteTable,
	readMiddlewareFlag,
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

	// =========================================================================
	// Tolerant-mode collision handling (E4 follow-up)
	// =========================================================================
	//
	// Without `onCollision`, the function throws on the first conflict — that
	// preserves the v0.4 strict-mode behavior the test suite above relies on.
	// With `onCollision`, conflicts are reported through the callback and the
	// offending entry is SKIPPED so the rest of the route table still builds.
	// Used by HttpTrigger at boot so one bad workflow doesn't drop the whole
	// table (which then falls back to the legacy catch-all and breaks every
	// URL — exactly the regression a user hit on the cross-runtime-chain demo).

	describe("tolerant mode (onCollision)", () => {
		it("does not throw on exact (method, path) duplicate when onCollision is set", () => {
			const collisions: RouteCollision[] = [];
			const out = buildRouteTable(
				[
					scanned({ source: "/a.json", defaultPath: "/users", name: "A" }),
					scanned({ source: "/b.json", defaultPath: "/users", name: "B" }),
				],
				[],
				{ onCollision: (c) => collisions.push(c) },
			);
			// First workflow wins, second is dropped.
			expect(out).toHaveLength(1);
			expect(out[0].source).toBe("/a.json");
			expect(collisions).toHaveLength(1);
			expect(collisions[0].kind).toBe("duplicate");
			expect(collisions[0].method).toBe("GET");
			expect(collisions[0].path).toBe("/users");
			expect(collisions[0].winnerSource).toBe("/a.json");
			expect(collisions[0].droppedSource).toBe("/b.json");
		});

		it("does not throw on ANY-shadows-specific when onCollision is set", () => {
			const collisions: RouteCollision[] = [];
			const out = buildRouteTable(
				[
					scanned({ source: "/get.json", defaultPath: "/x", method: "GET", name: "G" }),
					scanned({ source: "/any.json", defaultPath: "/x", method: "ANY", name: "A" }),
				],
				[],
				{ onCollision: (c) => collisions.push(c) },
			);
			expect(out).toHaveLength(1);
			expect(out[0].source).toBe("/get.json");
			expect(collisions).toHaveLength(1);
			expect(collisions[0].kind).toBe("any-shadows-specific");
		});

		it("collects ALL collisions, not just the first one", () => {
			const collisions: RouteCollision[] = [];
			const out = buildRouteTable(
				[
					scanned({ source: "/a.json", defaultPath: "/users", name: "A" }),
					scanned({ source: "/b.json", defaultPath: "/users", name: "B" }),
					scanned({ source: "/c.json", defaultPath: "/orders", name: "C" }),
					scanned({ source: "/d.json", defaultPath: "/orders", name: "D" }),
				],
				[],
				{ onCollision: (c) => collisions.push(c) },
			);
			expect(out).toHaveLength(2); // /users from A, /orders from C
			expect(collisions).toHaveLength(2); // B + D dropped
			expect(collisions.map((c) => c.droppedSource).sort()).toEqual(["/b.json", "/d.json"]);
		});

		it("non-colliding workflows still register when one pair collides — single bad workflow does not break the whole table", () => {
			const collisions: RouteCollision[] = [];
			const out = buildRouteTable(
				[
					scanned({ source: "/users.json", defaultPath: "/users", name: "U" }),
					scanned({ source: "/orders.json", defaultPath: "/orders", name: "O" }),
					scanned({ source: "/dup1.json", defaultPath: "/dup", name: "D1" }),
					scanned({ source: "/dup2.json", defaultPath: "/dup", name: "D2" }),
					scanned({ source: "/items.json", defaultPath: "/items", name: "I" }),
				],
				[],
				{ onCollision: (c) => collisions.push(c) },
			);
			// 4 non-colliding routes survive: /users, /orders, /dup (first wins), /items.
			expect(out).toHaveLength(4);
			expect(out.map((r) => r.path).sort()).toEqual(["/dup", "/items", "/orders", "/users"]);
			expect(collisions).toHaveLength(1);
		});
	});

	// =========================================================================
	// Bug 01 / F17 — middleware workflows are excluded from the route table.
	// =========================================================================

	describe("middleware exclusion", () => {
		it("excludes a SCANNED (JSON) middleware workflow even with a dummy http trigger (F17)", () => {
			const out = buildRouteTable([
				{
					source: "/wf/json/_mw/request-id.json",
					kind: "json",
					defaultPath: "/request-id",
					name: "request-id",
					workflow: {
						name: "request-id",
						version: "1.0.0",
						middleware: true,
						trigger: { http: { method: "ANY", path: "/__mw/request-id" } },
					},
				},
			]);
			expect(out).toHaveLength(0);
		});

		it("excludes a MANUAL (TS builder) middleware workflow with the flag on _config", () => {
			const out = buildRouteTable(
				[],
				[
					{
						key: "request-id",
						// Shape of a v2 `workflow({ middleware: true, trigger: {...} })` builder:
						// the middleware flag lives on `_config`, not the root.
						workflow: {
							_blokV2: true,
							_config: {
								name: "request-id",
								version: "1.0.0",
								middleware: true,
								trigger: { http: { method: "ANY", path: "/__mw/request-id" } },
							},
						},
					},
				],
			);
			expect(out).toHaveLength(0);
		});

		it("a non-middleware workflow alongside a middleware one still routes", () => {
			const out = buildRouteTable([
				scanned({ source: "/wf/users.json", defaultPath: "/users", name: "users" }),
				{
					source: "/wf/_mw/audit.json",
					kind: "json",
					defaultPath: "/audit",
					name: "audit",
					workflow: {
						name: "audit",
						version: "1.0.0",
						middleware: true,
						trigger: { http: { method: "POST", path: "/audit" } },
					},
				},
			]);
			expect(out).toHaveLength(1);
			expect(out[0].path).toBe("/users");
		});
	});
});

describe("readMiddlewareFlag", () => {
	it("returns true for a root `middleware: true` (JSON / object literal)", () => {
		expect(readMiddlewareFlag({ name: "x", middleware: true })).toBe(true);
	});

	it("returns true for `_config.middleware === true` (v2 workflow() builder)", () => {
		expect(readMiddlewareFlag({ _blokV2: true, _config: { name: "x", middleware: true } })).toBe(true);
	});

	it("returns false when the flag is absent", () => {
		expect(readMiddlewareFlag({ name: "x" })).toBe(false);
		expect(readMiddlewareFlag({ _config: { name: "x" } })).toBe(false);
	});

	it("treats only the literal `true` as the marker", () => {
		expect(readMiddlewareFlag({ middleware: false })).toBe(false);
		expect(readMiddlewareFlag({ middleware: 1 as unknown as boolean })).toBe(false);
		expect(readMiddlewareFlag({ middleware: "true" as unknown as boolean })).toBe(false);
	});

	it("is null/undefined/non-object safe", () => {
		expect(readMiddlewareFlag(null)).toBe(false);
		expect(readMiddlewareFlag(undefined)).toBe(false);
		expect(readMiddlewareFlag("middleware")).toBe(false);
		expect(readMiddlewareFlag(42)).toBe(false);
	});
});
