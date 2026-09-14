/**
 * Issue #1015 — the shared-data registry, the url/component overrides, prop
 * bundles, `viewData` and the history-size guard.
 *
 * Every case drives the REAL pipeline: `definePage().render()` → normalizer →
 * `PageNode` → `@blokjs/inertia`, through `runPage`/`runWorkflow`. The counters
 * on the shared resolvers are the proof of laziness — a value that "was not
 * needed" has to be a value that was never computed.
 *
 * Numbered cases map 1:1 to the tests listed in issue #1015.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, defineNode, workflow } from "@blokjs/core";
import { NodeTestHarness, runPage } from "@blokjs/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import InertiaNode, {
	_resetOversizedWarning,
	_resetPageRegistry,
	_resetRoutes,
	_resetShared,
	always,
	definePage,
	ensurePagesExist,
	getShared,
	resolveUrlUsing,
	share,
	shareOnce,
	transformComponentUsing,
	withProps,
} from "../src/index.js";
import type { PageObject } from "../src/protocol.js";

// =============================================================================
// Fixtures
// =============================================================================

const counts: Record<string, number> = {};
const calls = (name: string) => counts[name] ?? 0;
const bump = (name: string) => {
	counts[name] = calls(name) + 1;
};

/** One ordinary page prop, so the page always has something of its own. */
const loadStats = defineNode({
	name: "shared-load-stats",
	description: "a page prop",
	input: z.object({}),
	output: z.object({ total: z.number() }),
	async execute() {
		bump("stats");
		return { total: 7 };
	},
});

/** A page prop that COLLIDES with a shared key (test 3). */
const pageAuth = defineNode({
	name: "shared-page-auth",
	description: "a page prop named like a shared key",
	input: z.object({}),
	output: z.object({ id: z.string(), from: z.string() }),
	async execute() {
		return { id: "u-page", from: "page" };
	},
});

/** The node behind `shareOnce` (test 4). */
const loadCountries = defineNode({
	name: "shared-load-countries",
	description: "an expensive list the client caches",
	input: z.object({}),
	output: z.object({ list: z.array(z.string()) }),
	async execute() {
		bump("countries");
		return { list: ["BR", "NL"] };
	},
});

/** A 9 MiB prop (test 11). */
const hugeProp = defineNode({
	name: "shared-huge-prop",
	description: "a prop far past the history-state budget",
	input: z.object({}),
	output: z.object({ blob: z.string() }),
	async execute() {
		return { blob: "x".repeat(9 * 1024 * 1024) };
	},
});

const page = (component: string, url: string, props: Record<string, unknown> = {}, opts?: Record<string, unknown>) => {
	const def = definePage(component, props as never);
	return workflow(`wf-${component}`, { version: "1.0.0", trigger: http.get(url) }, (req) => {
		def.render(req, "page", url, {} as never, opts as never);
	});
};

/** The page object out of a `runPage` result. */
const pageObject = (result: { body: unknown }) => result.body as PageObject;

beforeEach(() => {
	for (const key of Object.keys(counts)) delete counts[key];
	_resetShared();
	_resetRoutes();
	_resetOversizedWarning();
});

afterEach(() => {
	_resetShared();
	_resetRoutes();
});

// =============================================================================
// 1 — a static shared value, and suppressing the key list
// =============================================================================

describe("1 — share() reaches every page, and announces its keys", () => {
	it("puts the value in props and the key in sharedProps", async () => {
		share("appName", "Blok");
		const result = await runPage(page("Shared/One", "/one", { stats: loadStats }));

		expect(result.props.appName).toBe("Blok");
		expect(pageObject(result).sharedProps).toEqual(["appName"]);
		// The page's own prop is untouched by any of this.
		expect(result.props.stats).toEqual({ total: 7 });
	});

	it("exposeSharedPropKeys:false hides the key list but keeps the value", async () => {
		share("appName", "Blok");
		const result = await runPage(page("Shared/Two", "/two", { stats: loadStats }, { exposeSharedPropKeys: false }));

		expect(result.props.appName).toBe("Blok");
		expect(pageObject(result).sharedProps).toBeUndefined();
	});
});

// =============================================================================
// 2 — lazy values run per request, and only when selected
// =============================================================================

describe("2 — a lazy shared value costs nothing on a request that excludes it", () => {
	it("is skipped on a partial that does not name it, and runs when it does", async () => {
		share("appUser", (req) => {
			bump("appUser");
			return { agent: (req as { headers?: Record<string, string> })?.headers?.["user-agent"] ?? "none" };
		});
		share("ziggy", () => {
			bump("ziggy");
			return { routes: ["/one"] };
		});

		// A full visit resolves both.
		const full = await runPage(page("Shared/Lazy", "/lazy", { stats: loadStats }), {
			headers: { "user-agent": "vitest" },
		});
		expect(full.props.appUser).toEqual({ agent: "vitest" });
		expect(calls("appUser")).toBe(1);
		expect(calls("ziggy")).toBe(1);

		// A partial asking only for `stats` resolves NEITHER.
		const narrowed = await runPage(page("Shared/Lazy2", "/lazy2", { stats: loadStats }), { partial: ["stats"] });
		expect(narrowed.props).not.toHaveProperty("appUser");
		expect(calls("appUser")).toBe(1);
		expect(calls("ziggy")).toBe(1);

		// A partial that names the shared key resolves exactly that one.
		const asked = await runPage(page("Shared/Lazy3", "/lazy3", { stats: loadStats }), { partial: ["appUser"] });
		expect(asked.props.appUser).toEqual({ agent: "none" });
		expect(calls("appUser")).toBe(2);
		expect(calls("ziggy")).toBe(1);
	});

	it("an `always` shared value survives both partial filters", async () => {
		share("flags", () => {
			bump("flags");
			return { beta: true };
		});
		share(
			"auth",
			() => {
				bump("auth");
				return { id: "u-1" };
			},
			{ always: true },
		);

		const narrowed = await runPage(page("Shared/Always", "/always", { stats: loadStats }), { partial: ["stats"] });
		expect(narrowed.props.auth).toEqual({ id: "u-1" });
		expect(narrowed.props).not.toHaveProperty("flags");
		expect(calls("auth")).toBe(1);
		expect(calls("flags")).toBe(0);

		const excluded = await runPage(page("Shared/Always2", "/always2", { stats: loadStats }), { except: ["auth"] });
		expect(excluded.props.auth).toEqual({ id: "u-1" });
		expect(calls("auth")).toBe(2);
	});

	it("getShared() reuses the value the request already resolved", async () => {
		share("tenant", () => {
			bump("tenant");
			return { id: "t-1" };
		});

		const reader = defineNode({
			name: "shared-tenant-reader",
			description: "a prop resolver that reads shared data",
			input: z.object({}),
			output: z.object({ tenantId: z.string() }),
			async execute(ctx) {
				const tenant = await getShared<{ id: string }>("tenant", { id: "none" }, ctx);
				return { tenantId: tenant.id };
			},
		});

		const result = await runPage(page("Shared/Get", "/get", { report: reader }));
		expect(result.props.report).toEqual({ tenantId: "t-1" });
		expect(result.props.tenant).toEqual({ id: "t-1" });
		// Resolved ONCE for the request, even though two places read it.
		expect(calls("tenant")).toBe(1);
	});
});

// =============================================================================
// 3 — collision: the page wins
// =============================================================================

describe("3 — a page prop overrides a shared key of the same name", () => {
	it("keeps the page's value and never resolves the shared one", async () => {
		share("auth", () => {
			bump("auth");
			return { id: "u-shared", from: "shared" };
		});

		const result = await runPage(page("Shared/Collide", "/collide", { auth: pageAuth }));
		expect(result.props.auth).toEqual({ id: "u-page", from: "page" });
		expect(calls("auth")).toBe(0);
	});
});

// =============================================================================
// 4 — shareOnce
// =============================================================================

describe("4 — shareOnce() resolves once and the client keeps it", () => {
	it("ships the value with an expiring onceProps entry, then stops resolving it", async () => {
		shareOnce("countries", loadCountries, { until: "1d" });

		const first = await runPage(page("Shared/Once", "/once", { stats: loadStats }));
		expect(first.props.countries).toEqual({ list: ["BR", "NL"] });
		expect(calls("countries")).toBe(1);
		const entry = first.onceProps.countries as { prop: string; expiresAt: number };
		expect(entry.prop).toBe("countries");
		// Epoch MILLISECONDS, in the future: the client keeps a remembered entry
		// while `expiresAt > Date.now()`, a comparison any other shape loses —
		// and shared entries share the page's `onceProps` map (#1009).
		expect(typeof entry.expiresAt).toBe("number");
		expect(entry.expiresAt).toBeGreaterThan(Date.now());
		const ttl = entry.expiresAt - Date.now();
		expect(ttl).toBeGreaterThan(23 * 3_600_000);
		expect(ttl).toBeLessThanOrEqual(24 * 3_600_000 + 1000);

		// The client says it still holds the cached copy.
		const cached = await runPage(page("Shared/Once2", "/once2", { stats: loadStats }), {
			headers: { "x-inertia-except-once-props": "countries" },
		});
		expect(cached.props).not.toHaveProperty("countries");
		expect(calls("countries")).toBe(1);
		// The ENTRY still ships: dropping it would invalidate the client's cache.
		expect((cached.onceProps.countries as { prop: string }).prop).toBe("countries");
	});

	it("resolves on a partial reload without `only` unless the client says it holds it (#1009)", async () => {
		shareOnce("countries", loadCountries);

		// A bare `router.reload()`: no `only`, and no except-once header — the
		// client does NOT have the value, so the shared entry belongs to the
		// regular set and resolves. Same rule as a page-level `once` prop.
		const reloaded = await runPage(page("Shared/Bare", "/bare", { stats: loadStats }), {
			headers: { "x-inertia-partial-component": "Shared/Bare" },
		});
		expect(reloaded.props.countries).toEqual({ list: ["BR", "NL"] });
		expect(calls("countries")).toBe(1);

		// Same request, but now the client holds it: the resolver never runs.
		const held = await runPage(page("Shared/Bare2", "/bare2", { stats: loadStats }), {
			headers: {
				"x-inertia-partial-component": "Shared/Bare2",
				"x-inertia-except-once-props": "countries",
			},
		});
		expect(held.props).not.toHaveProperty("countries");
		expect(calls("countries")).toBe(1);
	});

	it("resolves again when an absolute `until` has already passed (#1009)", async () => {
		shareOnce("countries", loadCountries, { until: "2020-01-01T00:00:00.000Z" });

		const stale = await runPage(page("Shared/Stale", "/stale", { stats: loadStats }), {
			headers: { "x-inertia-except-once-props": "countries" },
		});
		// The client's claim is stale, so the value ships despite the header.
		expect(stale.props.countries).toEqual({ list: ["BR", "NL"] });
		expect(calls("countries")).toBe(1);
		expect((stale.onceProps.countries as { expiresAt: number }).expiresAt).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
	});
});

// =============================================================================
// 6 / 7 — url and component overrides
// =============================================================================

describe("6 — resolveUrlUsing() decides the page-object url", () => {
	it("uses the resolver's output instead of the request URL", async () => {
		resolveUrlUsing((req) => `/tenant-a${(req as { url?: string })?.url ?? ""}`);
		const result = await runPage(page("Shared/Url", "/url", { stats: loadStats }), { url: "/url?page=2" });
		expect(result.url).toBe("/tenant-a/url?page=2");
	});
});

describe("7 — transformComponentUsing() renames the component before it is emitted", () => {
	it("emits the transformed name, and still narrows a partial addressed to it", async () => {
		transformComponentUsing((name) => name.toLowerCase());
		share("appName", "Blok");

		const result = await runPage(page("Shared/Case", "/case", { stats: loadStats }));
		expect(result.component).toBe("shared/case");

		// The client echoes the TRANSFORMED name back on a partial reload, so the
		// narrowing has to compare against it.
		const narrowed = await runPage(page("Shared/Case2", "/case2", { stats: loadStats }), {
			headers: { "x-inertia-partial-component": "shared/case2", "x-inertia-partial-data": "stats" },
		});
		expect(narrowed.props).not.toHaveProperty("appName");
		expect(narrowed.props.stats).toEqual({ total: 7 });
	});
});

// =============================================================================
// 8 — ensurePagesExist
// =============================================================================

describe("8 — ensurePagesExist() fails the boot on a component the client does not have", () => {
	// The page registry is module-global and every case above added to it, so
	// each check here starts from only the pages it declares itself.
	beforeEach(() => {
		_resetPageRegistry();
	});

	function manifest(pages: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "blok-pages-"));
		const file = join(dir, "pages.json");
		writeFileSync(file, JSON.stringify({ root: "resources/js/Pages", pages }));
		return file;
	}

	it("names the missing component and how to fix it", async () => {
		definePage("Nope/Missing", {});
		definePage("Real/Here", {});
		const file = manifest(["Real/Here"]);

		await expect(ensurePagesExist({ manifest: file, enabled: true })).rejects.toThrow(/Nope\/Missing/);
		await expect(ensurePagesExist({ manifest: file, enabled: true })).rejects.toThrow(/Fix:/);
	});

	it("passes when every component exists, and applies the component transform first", async () => {
		definePage("Ok/One", {});
		await expect(ensurePagesExist({ manifest: manifest(["Ok/One"]), enabled: true })).resolves.toBeUndefined();

		transformComponentUsing((name) => name.toLowerCase());
		await expect(ensurePagesExist({ manifest: manifest(["ok/one"]), enabled: true })).resolves.toBeUndefined();
		await expect(ensurePagesExist({ manifest: manifest(["Ok/One"]), enabled: true })).rejects.toThrow(/ok\/one/);
	});

	it("is off in production, and warns rather than throws when there is no manifest", async () => {
		definePage("Nope/Missing2", {});
		const previous = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "production";
			await expect(ensurePagesExist({ manifest: manifest([]) })).resolves.toBeUndefined();
		} finally {
			if (previous === undefined) process.env.NODE_ENV = "test";
			else process.env.NODE_ENV = previous;
		}

		const warnings: string[] = [];
		await ensurePagesExist({
			manifest: join(tmpdir(), "blok-no-such-pages.json"),
			enabled: true,
			warn: (message) => warnings.push(message),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/no page manifest/);
	});
});

// =============================================================================
// 9 — viewData is shell-only
// =============================================================================

describe("9 — viewData fills the shell and never reaches the client", () => {
	it("puts the title in <title> and nothing in props", async () => {
		const result = await runPage(page("Shared/View", "/view", { stats: loadStats }, { viewData: { title: "X-Ray" } }), {
			headers: { "x-inertia": "" },
		});
		const html = result.body as string;
		expect(typeof html).toBe("string");
		expect(html).toContain("<title data-inertia>X-Ray</title>");
		// The boot script carries the page object; `viewData` is not in it.
		expect(html).not.toContain("viewData");
		expect(html).not.toContain('"title"');
	});
});

// =============================================================================
// 10 — reusable prop bundles
// =============================================================================

describe("10 — withProps() bundles the same props into two pages", () => {
	it("gives both pages the bundle's keys", async () => {
		const bundle = withProps({ auth: always(pageAuth), stats: loadStats });
		const one = await runPage(page("Shared/BundleA", "/bundle-a", { ...bundle }));
		const two = await runPage(page("Shared/BundleB", "/bundle-b", { ...bundle, extra: loadStats }));

		expect(one.props.auth).toEqual({ id: "u-page", from: "page" });
		expect(one.props.stats).toEqual({ total: 7 });
		expect(two.props.auth).toEqual({ id: "u-page", from: "page" });
		expect(two.props.stats).toEqual({ total: 7 });
		expect(two.props.extra).toEqual({ total: 7 });
	});
});

// =============================================================================
// 11 — the history-size guard
// =============================================================================

describe("11 — a page past the history budget warns once and still ships", () => {
	it("logs one warning and returns the response anyway", async () => {
		const harness = new NodeTestHarness(InertiaNode as never);
		const input = {
			component: "Shared/Huge",
			props: { blob: "x".repeat(9 * 1024 * 1024) },
			url: "/huge",
			version: "v1",
			headers: { "x-inertia": "true" },
		};

		const first = await harness.execute(input as never);
		expect(first.success).toBe(true);
		expect((first.data as { body: PageObject }).body.component).toBe("Shared/Huge");
		const warnings = first.logs.filter((line) => line.includes("history state"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("9.0 MiB");

		// Once per process: a second oversized render says nothing.
		const second = await harness.execute(input as never);
		expect(second.success).toBe(true);
		expect(second.logs.filter((line) => line.includes("history state"))).toHaveLength(0);
	});

	it("says nothing for an ordinary page", async () => {
		const harness = new NodeTestHarness(InertiaNode as never);
		const result = await harness.execute({
			component: "Shared/Small",
			props: { a: 1 },
			url: "/",
			version: "",
		} as never);
		expect(result.logs.filter((line) => line.includes("history state"))).toHaveLength(0);
	});

	it("ships a 9 MiB prop through the real page pipeline", async () => {
		const result = await runPage(page("Shared/Big", "/big", { huge: hugeProp }));
		expect(result.status).toBe(200);
		expect((result.props.huge as { blob: string }).blob.length).toBe(9 * 1024 * 1024);
	});
});
