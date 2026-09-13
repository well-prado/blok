/**
 * Issue #1013 — history encryption, `clearHistory` on logout, and the
 * `can()` / `authorize()` authorization convention.
 *
 * Everything here runs through the REAL harness: `runNode` (Zod-validated in
 * and out) for the per-page and adapter-default paths, and `runWorkflow` (the
 * real Configuration + Runner) for the request-scoped mark, which only exists
 * because middleware and the workflow it guards share one `ctx`.
 *
 * The wire-level halves — a 303 actually leaving an HTTP trigger, and the 403
 * body actually reaching the response — live in
 * `triggers/http/__tests__/unit/HttpTrigger.inertia-security.test.ts`, which
 * boots a real `HttpTrigger`.
 */

import { http, step, workflow } from "@blokjs/core";
import { runNode, runWorkflow } from "@blokjs/core/testing";
import { GlobalError, type RespondEnvelope } from "@blokjs/shared";
import { afterEach, describe, expect, it } from "vitest";
import InertiaNode, {
	type PageObject,
	authorize,
	authorizeNode,
	can,
	clearHistory,
	configureHistory,
	encryptHistory,
	historyMarks,
	historyNode,
	historyOptions,
	logoutNode,
	logoutResponse,
} from "../src/index.js";

const INERTIA: Record<string, string> = { "x-inertia": "true" };

async function page(input: Record<string, unknown>): Promise<PageObject> {
	const env = (await runNode(InertiaNode, { headers: INERTIA, ...input } as never)) as unknown as RespondEnvelope;
	return env.body as PageObject;
}

afterEach(() => {
	// The adapter default is module state — a leaked `true` would silently
	// pass every other assertion in this file.
	configureHistory({ encrypt: false });
});

// =============================================================================
// 1 — encryptHistory: per page, per request, per app
// =============================================================================

describe("1 — encryptHistory", () => {
	it("emits the field only when the page asks for it", async () => {
		expect(await page({ component: "Home", ...encryptHistory() })).toMatchObject({ encryptHistory: true });
		expect(await page({ component: "Home" })).not.toHaveProperty("encryptHistory");
	});

	it("global history.encrypt puts it on every page, and encryptHistory(false) takes it off", async () => {
		configureHistory({ encrypt: true });
		expect(historyOptions()).toEqual({ encrypt: true });

		expect(await page({ component: "Home" })).toMatchObject({ encryptHistory: true });
		expect(await page({ component: "Users/Index" })).toMatchObject({ encryptHistory: true });
		// The per-page opt-out beats the global default — and never emits `false`.
		expect(await page({ component: "Home", ...encryptHistory(false) })).not.toHaveProperty("encryptHistory");
	});

	it("the middleware's mark reaches every page in the same request", async () => {
		// This is exactly what `inertia.encryptHistory` does: one `historyNode`
		// step marking the shared ctx, then the page steps.
		const wf = await workflow("mw-encrypt", { version: "1.0.0", trigger: http.get("/mw") }, () => {
			step("mark", historyNode, { encrypt: true }, { ephemeral: true });
			step("page", InertiaNode, { component: "Secret", headers: INERTIA });
		});

		const run = await runWorkflow(wf, {});
		expect(run.ok).toBe(true);
		expect((run.response as RespondEnvelope).body).toMatchObject({ component: "Secret", encryptHistory: true });
	});

	it("a page can still opt out of a marked request", async () => {
		const wf = await workflow("mw-encrypt-optout", { version: "1.0.0", trigger: http.get("/mw2") }, () => {
			step("mark", historyNode, { encrypt: true }, { ephemeral: true });
			step("page", InertiaNode, { component: "Public", headers: INERTIA, ...encryptHistory(false) });
		});

		const run = await runWorkflow(wf, {});
		expect(run.ok).toBe(true);
		expect((run.response as RespondEnvelope).body).not.toHaveProperty("encryptHistory");
	});

	it("the middleware workflow is a trigger-less `middleware: true` workflow named inertia.encryptHistory", async () => {
		const { encryptHistoryMiddleware } = await import("../src/index.js");
		const mw = (await encryptHistoryMiddleware()) as { _config: { name: string; middleware?: unknown } };
		expect(mw._config.name).toBe("inertia.encryptHistory");
		expect(mw._config.middleware).toBe(true);
	});
});

// =============================================================================
// 2 — logout: 303 + clearHistory
// =============================================================================

describe("2 — logout", () => {
	it("answers 303 to /login and never 302 (a 302 replays the logout write)", async () => {
		const env = (await runNode(logoutNode, {} as never)) as unknown as RespondEnvelope;
		expect(env.status).toBe(303);
		expect(env.headers?.Location).toBe("/login");

		const custom = (await runNode(logoutNode, { redirectTo: "/goodbye" } as never)) as unknown as RespondEnvelope;
		expect(custom.headers?.Location).toBe("/goodbye");
	});

	it("marks the request so the page rendered after it carries clearHistory: true", async () => {
		const wf = await workflow("logout-then-render", { version: "1.0.0", trigger: http.post("/logout") }, () => {
			step("logout", logoutNode, {}, { ephemeral: true });
			step("page", InertiaNode, { component: "Auth/Login", headers: INERTIA });
		});

		const run = await runWorkflow(wf, {});
		expect(run.ok).toBe(true);
		expect((run.response as RespondEnvelope).body).toMatchObject({ component: "Auth/Login", clearHistory: true });
	});

	it("logoutResponse marks any ctx-shaped object it is handed", () => {
		const ctx = { request: { method: "POST" } };
		const env = logoutResponse(ctx, { redirectTo: "/login" });
		expect(env.status).toBe(303);
		expect(historyMarks(ctx)).toEqual({ clear: true });
	});

	it("clearHistory() is spreadable as a page input, and clearHistory(false) opts out", async () => {
		expect(await page({ component: "Home", ...clearHistory() })).toMatchObject({ clearHistory: true });
		expect(await page({ component: "Home", ...clearHistory(false) })).not.toHaveProperty("clearHistory");
	});
});

// =============================================================================
// 3 — authorize / can
// =============================================================================

describe("3 — authorize()", () => {
	it("throws a 403 GlobalError carrying { error: 'forbidden', ability }", () => {
		let thrown: unknown;
		try {
			authorize("edit", false);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(GlobalError);
		const err = thrown as GlobalError;
		expect(err.context.code).toBe(403);
		expect(err.context.json).toEqual({ error: "forbidden", ability: "edit" });
		expect(err.name).toBe("Forbidden");
	});

	it("is a no-op when the ability is allowed, and accepts a lazy rule", () => {
		expect(() => authorize("edit", true)).not.toThrow();
		expect(() => authorize("edit", () => true)).not.toThrow();
		expect(() => authorize("edit", () => false)).toThrow(/edit/);
	});

	it("fails the step when used as a node, and passes it through when allowed", async () => {
		await expect(runNode(authorizeNode, { ability: "edit", allowed: false } as never)).rejects.toThrow(/edit/);
		expect(await runNode(authorizeNode, { ability: "edit", allowed: true } as never)).toEqual({
			ability: "edit",
			allowed: true,
		});
	});

	it("stops the workflow at the guard step", async () => {
		const wf = await workflow("guarded", { version: "1.0.0", trigger: http.get("/guarded") }, () => {
			step("guard", authorizeNode, { ability: "edit", allowed: false }, { ephemeral: true });
			step("page", InertiaNode, { component: "Posts/Edit", headers: INERTIA });
		});

		const run = await runWorkflow(wf, {});
		expect(run.ok).toBe(false);
		expect(run.step("page")?.executed).toBe(false);
	});
});

describe("3b — can()", () => {
	it("flattens booleans and lazy rules into the plain `can` prop object", () => {
		expect(can({ create: true, delete: false })).toEqual({ create: true, delete: false });
		expect(can({ edit: () => 1 + 1 === 2, publish: () => false })).toEqual({ edit: true, publish: false });
	});

	it("is usable per item, which is the whole point of the convention", () => {
		const user = { id: 7 };
		const posts = [
			{ id: "a", authorId: 7 },
			{ id: "b", authorId: 9 },
		];
		const withCan = posts.map((post) => ({ ...post, can: can({ edit: () => post.authorId === user.id }) }));
		expect(withCan.map((p) => p.can.edit)).toEqual([true, false]);
	});
});
