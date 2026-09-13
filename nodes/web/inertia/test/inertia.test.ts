/**
 * `@blokjs/inertia` unit suite — the node is driven through the REAL
 * `runNode` harness (Zod-validated in and out), so every assertion here
 * covers the shipped execution path.
 *
 * Numbered cases map 1:1 to the tests listed in issue #994.
 */

import { runNode } from "@blokjs/core/testing";
import type { RespondEnvelope } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import InertiaNode, { type PageObject, location, redirect, serializePage } from "../src/index.js";

type Envelope = RespondEnvelope;

const INERTIA: Record<string, string> = { "x-inertia": "true" };

/** Run the node and return the envelope it produced. */
async function run(input: Record<string, unknown>): Promise<Envelope> {
	return (await runNode(InertiaNode, input as never)) as unknown as Envelope;
}

/** The `<script type="application/json" data-page="…">` body, unparsed. */
function bootScript(html: string): string {
	const match = html.match(/<script type="application\/json" data-page="[^"]*">([\s\S]*?)<\/script>/);
	if (!match) throw new Error(`no boot script in:\n${html}`);
	return match[1] as string;
}

/** What the browser would hand to JSON.parse — `textContent`, no entity decoding. */
function bootPage(html: string): PageObject {
	return JSON.parse(bootScript(html)) as PageObject;
}

function pageOf(env: Envelope): PageObject {
	return env.body as PageObject;
}

describe("1 — initial HTML response (no X-Inertia header)", () => {
	it("delivers the page in a script tag, escapes `/`, and varies on X-Inertia", async () => {
		const env = await run({
			component: "Users/Index",
			props: { path: "a/b" },
			url: "/users",
			version: "v1",
		});

		expect(env.status).toBe(200);
		expect(env.contentType).toBe("text/html; charset=utf-8");
		expect(env.headers?.Vary).toBe("X-Inertia");
		expect(env.headers?.["X-Inertia"]).toBeUndefined();

		const html = env.body as string;
		expect(html).toContain('<div id="app"></div>');
		expect(html).toContain('<script type="application/json" data-page="app">');
		// v3 uses the script element — never the v2 `data-page` ATTRIBUTE on the div.
		expect(html).not.toMatch(/<div id="app" data-page=/);
		expect(html).toContain("<title data-inertia>");

		const raw = bootScript(html);
		expect(raw).toContain("a\\/b");
		// No HTML-entity encoding: the browser does not decode entities in <script>.
		expect(raw).not.toContain("&quot;");
		expect(raw).not.toContain("&amp;");

		const page = bootPage(html);
		expect(page).toEqual({
			component: "Users/Index",
			props: { path: "a/b", errors: {} },
			url: "/users",
			version: "v1",
		});
	});

	it("honours a custom root element id and injects head + viewData", async () => {
		const env = await run({
			component: "Home",
			url: "/",
			rootId: "root",
			head: '<meta data-inertia="description" content="hi" />',
			viewData: { title: "Dashboard" },
		});
		const html = env.body as string;
		expect(html).toContain('<div id="root"></div>');
		expect(html).toContain('data-page="root"');
		expect(html).toContain('<meta data-inertia="description" content="hi" />');
		expect(html).toContain("<title data-inertia>Dashboard</title>");
		// viewData is shell-only — it must never reach the client.
		expect(bootPage(html).props).toEqual({ errors: {} });
	});
});

describe("2 — a prop that tries to close the script tag", () => {
	it("cannot break out of the script element, and the page still parses", async () => {
		const hostile = "</script><script>x</script>";
		const env = await run({ component: "Home", props: { hostile }, url: "/" });
		const html = env.body as string;

		// Exactly one script element, and the hostile string is not in it verbatim.
		expect(html.match(/<\/script>/g)).toHaveLength(1);
		const raw = bootScript(html);
		expect(raw).not.toContain("</script>");
		expect(raw).toContain("\\u003C\\/script>");

		expect(bootPage(html).props.hostile).toBe(hostile);
	});

	it("escapes `<!--` and the JS line terminators", () => {
		const raw = serializePage({ a: "<!-- x", b: `y${String.fromCharCode(0x2028)}z` });
		expect(raw).not.toContain("<!--");
		expect(raw).not.toContain(String.fromCharCode(0x2028));
		expect(raw).toContain("\\u2028");
		expect(JSON.parse(raw)).toEqual({ a: "<!-- x", b: `y${String.fromCharCode(0x2028)}z` });
	});
});

describe("3 — Inertia JSON response", () => {
	it("returns the page object with X-Inertia + Vary and an always-present errors bag", async () => {
		const env = await run({ component: "Users/Index", props: { a: 1 }, url: "/users", headers: INERTIA });
		expect(env.status).toBe(200);
		expect(env.contentType).toBe("application/json");
		expect(env.headers?.["X-Inertia"]).toBe("true");
		expect(env.headers?.Vary).toBe("X-Inertia");
		const page = pageOf(env);
		expect(page.props.errors).toEqual({});
		expect(page.version).toBe("");
	});

	it("nests errors under X-Inertia-Error-Bag when the client asks for one", async () => {
		const env = await run({
			component: "Users/Create",
			url: "/users/create",
			errors: { email: "taken" },
			headers: { ...INERTIA, "x-inertia-error-bag": "createUser" },
		});
		expect(pageOf(env).props.errors).toEqual({ createUser: { email: "taken" } });
	});
});

describe("4 — history + fragment flags are omitted unless true", () => {
	for (const field of ["encryptHistory", "clearHistory", "preserveFragment"] as const) {
		it(`omits ${field} when false and emits it when true`, async () => {
			const off = pageOf(await run({ component: "Home", url: "/", headers: INERTIA, [field]: false }));
			expect(field in off).toBe(false);

			const on = pageOf(await run({ component: "Home", url: "/", headers: INERTIA, [field]: true }));
			expect(on[field]).toBe(true);
		});
	}
});

describe("5 — merge metadata", () => {
	it("emits merge labels verbatim", async () => {
		const page = pageOf(
			await run({
				component: "Posts",
				url: "/posts",
				headers: INERTIA,
				mergeProps: ["posts.data"],
				matchPropsOn: ["posts.data.id"],
				prependProps: ["feed.items"],
				deepMergeProps: ["settings"],
			}),
		);
		expect(page.mergeProps).toEqual(["posts.data"]);
		expect(page.matchPropsOn).toEqual(["posts.data.id"]);
		expect(page.prependProps).toEqual(["feed.items"]);
		expect(page.deepMergeProps).toEqual(["settings"]);
	});

	it("omits every empty array", async () => {
		const page = pageOf(
			await run({
				component: "Posts",
				url: "/posts",
				headers: INERTIA,
				mergeProps: [],
				matchPropsOn: [],
				prependProps: [],
				deepMergeProps: [],
				scrollProps: {},
			}),
		);
		expect(Object.keys(page)).toEqual(["component", "props", "url", "version"]);
	});
});

describe("6 — deferredProps / rescuedProps visibility", () => {
	const deferred = { default: ["stats"] };

	it("emits deferredProps on a full visit and rescuedProps never", async () => {
		const page = pageOf(
			await run({
				component: "Dash",
				url: "/dash",
				headers: INERTIA,
				deferredProps: deferred,
				rescuedProps: ["stats"],
			}),
		);
		expect(page.deferredProps).toEqual(deferred);
		expect(page.rescuedProps).toBeUndefined();
	});

	it("flips on a partial reload of the same component", async () => {
		const page = pageOf(
			await run({
				component: "Dash",
				url: "/dash",
				headers: { ...INERTIA, "x-inertia-partial-component": "Dash", "x-inertia-partial-data": "stats" },
				props: { stats: 1 },
				deferredProps: deferred,
				rescuedProps: ["stats"],
			}),
		);
		expect(page.deferredProps).toBeUndefined();
		expect(page.rescuedProps).toEqual(["stats"]);
	});
});

describe("7 — sharedProps", () => {
	it("emits the shared registry list", async () => {
		const page = pageOf(await run({ component: "Home", url: "/", headers: INERTIA, sharedProps: ["auth", "flash"] }));
		expect(page.sharedProps).toEqual(["auth", "flash"]);
	});

	it("is suppressed by exposeSharedPropKeys: false", async () => {
		const page = pageOf(
			await run({
				component: "Home",
				url: "/",
				headers: INERTIA,
				sharedProps: ["auth"],
				exposeSharedPropKeys: false,
			}),
		);
		expect(page.sharedProps).toBeUndefined();
	});
});

describe("8 — onceProps", () => {
	it("normalizes to { prop, expiresAt } with a null default", async () => {
		const page = pageOf(
			await run({
				component: "Home",
				url: "/",
				headers: INERTIA,
				props: { menu: ["a"], config: { x: 1 } },
				onceProps: { "menu:v1": { prop: "menu" }, "config:v1": { prop: "config", expiresAt: "2030-01-01T00:00:00Z" } },
			}),
		);
		expect(page.onceProps).toEqual({
			"menu:v1": { prop: "menu", expiresAt: null },
			"config:v1": { prop: "config", expiresAt: "2030-01-01T00:00:00Z" },
		});
	});

	it("drops the prop AND the entry the client says it already has", async () => {
		const page = pageOf(
			await run({
				component: "Home",
				url: "/",
				headers: { ...INERTIA, "x-inertia-except-once-props": "menu:v1" },
				props: { menu: ["a"], other: 1 },
				onceProps: { "menu:v1": { prop: "menu" } },
			}),
		);
		expect(page.props).toEqual({ other: 1, errors: {} });
		expect(page.onceProps).toBeUndefined();
	});
});

describe("9 — flash", () => {
	it("is emitted only when non-empty", async () => {
		const empty = pageOf(await run({ component: "Home", url: "/", headers: INERTIA, flash: {} }));
		expect(empty.flash).toBeUndefined();

		const filled = pageOf(await run({ component: "Home", url: "/", headers: INERTIA, flash: { success: "saved" } }));
		expect(filled.flash).toEqual({ success: "saved" });
	});
});

describe("10 — asset version mismatch", () => {
	const mismatch = { ...INERTIA, "x-inertia-version": "v1" };

	it("answers a GET with 409 + Location + current version, and no X-Inertia header", async () => {
		const env = await run({ component: "Home", url: "/users", version: "v2", method: "GET", headers: mismatch });
		expect(env.status).toBe(409);
		expect(env.headers?.["X-Inertia-Location"]).toBe("/users");
		expect(env.headers?.["X-Inertia-Version"]).toBe("v2");
		expect(env.headers?.["X-Inertia"]).toBeUndefined();
		expect(env.body).toBeUndefined();
	});

	it("never fires on a non-GET", async () => {
		const env = await run({ component: "Home", url: "/users", version: "v2", method: "POST", headers: mismatch });
		expect(env.status).toBe(200);
		expect(pageOf(env).version).toBe("v2");
	});

	it("does not fire when the versions match, or when the client sends none", async () => {
		const same = await run({
			component: "Home",
			url: "/",
			version: "v2",
			headers: { ...INERTIA, "x-inertia-version": "v2" },
		});
		expect(same.status).toBe(200);
		const none = await run({ component: "Home", url: "/", version: "v2", headers: INERTIA });
		expect(none.status).toBe(200);
	});
});

describe("11 — location()", () => {
	it("returns 409 + X-Inertia-Location", () => {
		const env = location("https://x.example/login");
		expect(env.status).toBe(409);
		expect(env.headers?.["X-Inertia-Location"]).toBe("https://x.example/login");
		expect(env.body).toBeUndefined();
	});

	it("is reachable from the node", async () => {
		const env = await run({ location: "https://x.example/login", headers: INERTIA });
		expect(env.status).toBe(409);
		expect(env.headers?.["X-Inertia-Location"]).toBe("https://x.example/login");
	});
});

describe("12 — fragment redirect", () => {
	it("answers a non-prefetch with 409 + X-Inertia-Redirect", async () => {
		const env = await run({ redirect: "/a#b", headers: INERTIA });
		expect(env.status).toBe(409);
		expect(env.headers?.["X-Inertia-Redirect"]).toBe("/a#b");
		expect(env.headers?.Location).toBeUndefined();
	});

	it("stays an ordinary redirect for a prefetch", async () => {
		const get = await run({ redirect: "/a#b", headers: { ...INERTIA, purpose: "prefetch" } });
		expect(get.status).toBe(302);
		expect(get.headers?.Location).toBe("/a#b");
		expect(get.headers?.["X-Inertia-Redirect"]).toBeUndefined();

		const del = await run({ redirect: "/a#b", method: "DELETE", headers: { ...INERTIA, purpose: "prefetch" } });
		expect(del.status).toBe(303);
	});
});

describe("13 — redirect status by method", () => {
	it("is 303 after DELETE/PUT/PATCH and 302 after GET/POST", () => {
		expect(redirect("/a", { method: "DELETE" }).status).toBe(303);
		expect(redirect("/a", { method: "put" }).status).toBe(303);
		expect(redirect("/a", { method: "PATCH" }).status).toBe(303);
		expect(redirect("/a", { method: "GET" }).status).toBe(302);
		expect(redirect("/a", { method: "POST" }).status).toBe(302);
		expect(redirect("/a").status).toBe(302);
	});

	it("marks preserveFragment on the redirect and emits the page field on the follow-up", async () => {
		const env = redirect("/a", { method: "DELETE", preserveFragment: true });
		expect(env.status).toBe(303);
		expect(env.headers?.["X-Inertia-Preserve-Fragment"]).toBe("true");

		const page = pageOf(await run({ component: "Home", url: "/a", headers: INERTIA, preserveFragment: true }));
		expect(page.preserveFragment).toBe(true);
	});
});

describe("15 — partial reloads", () => {
	const props = { a: 1, b: 2, c: 3, posts: { data: [1, 2], meta: { total: 2 } } };

	it("ignores the partial headers when the component does not match", async () => {
		const page = pageOf(
			await run({
				component: "Users/Index",
				url: "/users",
				props,
				headers: { ...INERTIA, "x-inertia-partial-component": "Other", "x-inertia-partial-data": "a" },
			}),
		);
		expect(page.props).toEqual({ ...props, errors: {} });
	});

	it("narrows with Partial-Data, then removes with Partial-Except, keeping errors + always props", async () => {
		const page = pageOf(
			await run({
				component: "Users/Index",
				url: "/users",
				props,
				errors: { email: "bad" },
				alwaysProps: ["c"],
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Users/Index",
					"x-inertia-partial-data": "a,b",
					"x-inertia-partial-except": "b",
				},
			}),
		);
		expect(page.props).toEqual({ a: 1, c: 3, errors: { email: "bad" } });
	});

	it("narrows on a dot path", async () => {
		const page = pageOf(
			await run({
				component: "Users/Index",
				url: "/users",
				props,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Users/Index",
					"x-inertia-partial-data": "posts.data",
				},
			}),
		);
		expect(page.props).toEqual({ posts: { data: [1, 2] }, errors: {} });
	});

	it("removes a dot path with Partial-Except", async () => {
		const page = pageOf(
			await run({
				component: "Users/Index",
				url: "/users",
				props,
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Users/Index",
					"x-inertia-partial-except": "posts.meta",
				},
			}),
		);
		expect(page.props).toEqual({ a: 1, b: 2, c: 3, posts: { data: [1, 2] }, errors: {} });
	});
});

describe("16 — reset", () => {
	it("strips the merge label and flags the scroll prop", async () => {
		const page = pageOf(
			await run({
				component: "Posts",
				url: "/posts",
				headers: {
					...INERTIA,
					"x-inertia-partial-component": "Posts",
					"x-inertia-reset": "posts.data",
				},
				props: { posts: { data: [1] } },
				mergeProps: ["posts.data", "feed.items"],
				scrollProps: { "posts.data": { pageName: "page", currentPage: 1, nextPage: 2 } },
			}),
		);
		expect(page.mergeProps).toEqual(["feed.items"]);
		expect(page.scrollProps?.["posts.data"]?.reset).toBe(true);
		expect(page.scrollProps?.["posts.data"]?.pageName).toBe("page");
	});

	it("moves a scroll prop between merge and prepend on the client's merge intent", async () => {
		const page = pageOf(
			await run({
				component: "Posts",
				url: "/posts",
				headers: { ...INERTIA, "x-inertia-infinite-scroll-merge-intent": "prepend" },
				mergeProps: ["posts.data"],
				scrollProps: { "posts.data": { pageName: "page" } },
			}),
		);
		expect(page.mergeProps).toBeUndefined();
		expect(page.prependProps).toEqual(["posts.data"]);
	});
});

describe("node guards", () => {
	it("rejects a render with no component", async () => {
		await expect(run({ url: "/" })).rejects.toThrow(/component/);
	});

	it("falls back to ctx.request.headers, case-insensitively", async () => {
		const env = (await runNode(InertiaNode, { component: "Home" } as never, {
			request: { headers: { "X-Inertia": "true" } },
		})) as unknown as Envelope;
		expect(env.headers?.["X-Inertia"]).toBe("true");
		expect(env.contentType).toBe("application/json");
	});

	it("stores an absolute request URL as a relative one", async () => {
		const env = await run({ component: "Home", url: "http://localhost:4000/users?page=2", headers: INERTIA });
		expect(pageOf(env).url).toBe("/users?page=2");
	});
});
