/**
 * #1011 test 10 — the REAL `useForm().withPrecognition()` client, in jsdom,
 * against responses the REAL server pipeline produced.
 *
 * Two halves, neither mocked:
 *
 * - The SERVER half is `runPrecognition()` driving an actual workflow whose
 *   validation step carries `{ precognition: true }`. A `node:http` server
 *   replays exactly the status, headers and body the runner emitted, on the
 *   origin jsdom is pointed at (no CORS, no stubbed XHR).
 * - The CLIENT half is `@inertiajs/vue3`'s `useForm(...).withPrecognition(...)`,
 *   which delegates to `laravel-precognition`'s validator — the same code a
 *   browser runs. It is what puts `Precognition: true` and
 *   `Precognition-Validate-Only` on the wire, and what turns the `422` into
 *   `form.errors.sku` and the following `204` back into no error at all.
 *
 * What this canNOT cover, and why: the SUBMIT half of the issue's test 10.
 * `form.post()` is a router visit, and `@inertiajs/core`'s router never
 * completes one in this environment — `onStart` fires and no request is ever
 * issued (the precognition validator has already taken over the module-level
 * http client by then). The live-browser submit is #1003's; here the last
 * assertion proves the SERVER half of "submit still works" instead — the same
 * workflow, asked without the marker, runs the write — plus the fact that the
 * client issued nothing but dry runs.
 *
 * `@inertiajs/vue3` and `vue` are imported WITHOUT being manifest dependencies
 * of this package, deliberately: `useForm` is framework-side (it does not exist
 * in `@inertiajs/core`), this package must not gain a Vue dependency to
 * publish, and the workspace install already resolves both from
 * `packages/inertia-client`, which declares them. Same reasoning as the
 * `@blokjs/inertia` imports in `triggers/http/__tests__`.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://127.0.0.1:39442/" }
 */

import { type Server, createServer } from "node:http";
import { http, defineNode, step, workflow } from "@blokjs/core";
import { runPrecognition, runWorkflow } from "@blokjs/core/testing";
import { useForm } from "@inertiajs/vue3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const PORT = 39442;
/**
 * ABSOLUTE, not `/orders`: `laravel-precognition` ships a `fetch`-based client,
 * and Node's `fetch` has no notion of jsdom's document origin, so a relative
 * endpoint fails to parse. A browser resolves it against the page — #1003.
 */
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: Server;
/** The awaited workflow model, shared by the server handler and the test. */
let resolvedFlow: unknown;

/** Every POST the client made, so the test can assert the headers it SENT. */
const seen: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

// ─────────────────────────── the server workflow ───────────────────────────

/** Validation: returns `{ ok, errors }`, never throws. */
const checkOrder = defineNode({
	name: "pre-check-order",
	description: "Validate an order, reporting dot-path errors.",
	input: z.object({ body: z.record(z.unknown()).optional() }),
	output: z.object({ ok: z.boolean(), errors: z.record(z.unknown()) }),
	async execute(_ctx, input) {
		const body = input.body ?? {};
		const errors: Record<string, string> = {};
		if (typeof body.sku !== "string" || body.sku.length < 3) errors.sku = "Must be at least 3 characters.";
		if (typeof body.qty !== "number" || body.qty < 1) errors.qty = "Must be at least 1.";
		return { ok: Object.keys(errors).length === 0, errors };
	},
});

/** The write. A dry run must never reach it. */
const createOrder = defineNode({
	name: "pre-create-order",
	description: "The side effect precognition exists to skip.",
	input: z.object({}),
	output: z.object({ id: z.string() }),
	async execute() {
		return { id: "o-1" };
	},
});

const createFlow = workflow("pre-orders-create", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
	step("check", checkOrder, { body: req.body }, { precognition: true });
	step("create", createOrder, {});
});

beforeAll(async () => {
	const resolved = await createFlow;
	resolvedFlow = resolved;
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			seen.push({ headers: req.headers, body: raw });
			const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};

			// The precognition markers the CLIENT chose, handed straight to the
			// real runner — this is the whole point: nothing here decides the
			// status or the error shape, `runPrecognition` does.
			if (String(req.headers.precognition ?? "") === "true") {
				const only = String(req.headers["precognition-validate-only"] ?? "");
				const dry = await runPrecognition(resolved, {
					body,
					fields: only.length > 0 ? only.split(",") : [],
					nodes: [checkOrder, createOrder],
				});
				// `Content-Type` comes off the envelope's own `contentType` in the
				// real trigger (`emitRespondEnvelope`); this server has to add it
				// back by hand, and the client will not parse the body without it.
				res.writeHead(dry.status, {
					...dry.headers,
					...(dry.status === 422 ? { "Content-Type": "application/json" } : {}),
				});
				res.end(dry.status === 422 ? JSON.stringify({ errors: dry.errors }) : "");
				return;
			}

			// The client never submits in this test (see the end of the case), so a
			// non-precognition request here means the dry-run contract leaked.
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unexpected non-precognition request" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterAll(() => {
	server?.close();
});

/** Poll until `check()` holds, or fail with the last state. */
async function until(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("10 (#1011) — useForm().withPrecognition against the real 204/422 pipeline", () => {
	// The client's own validation debounce plus a redirect-following submit —
	// comfortably past vitest's 5s default.
	it("shows the field error without submitting, and does not block a real submit", { timeout: 20_000 }, async () => {
		const form = useForm("post", `${ORIGIN}/orders`, { sku: "", qty: 2 }).withPrecognition("post", `${ORIGIN}/orders`);
		// The client's own debounce is 1500ms; the FIRST validate fires
		// immediately, which is the behaviour under test.
		form.setValidationTimeout(50);

		form.sku = "ab";
		form.validate("sku");

		await until(() => form.errors.sku !== undefined, "the precognition error to arrive");
		expect(form.errors.sku).toBe("Must be at least 3 characters.");
		// `qty` is valid, and was not asked about either way.
		expect(form.errors.qty).toBeUndefined();

		// The request the CLIENT built: the markers are its doing, not ours.
		const dry = seen[0];
		expect(dry.headers.precognition).toBe("true");
		expect(String(dry.headers["precognition-validate-only"])).toContain("sku");
		// Nothing was written: a dry run is a dry run.
		expect(seen.filter((r) => r.headers.precognition !== "true")).toHaveLength(0);

		// Fixing the field clears it — a 204 this time.
		form.sku = "SKU-1";
		form.validate("sku");
		await until(() => form.errors.sku === undefined, "the error to clear on a 204");

		// …and the SAME workflow, asked without the marker, runs the write: the
		// `precognition: true` step stops a dry run and nothing else.
		const submitted = await runWorkflow(
			resolvedFlow,
			{ sku: "SKU-1", qty: 2 },
			{
				method: "POST",
				nodes: [checkOrder, createOrder],
			},
		);
		expect(submitted.ok).toBe(true);
		expect(submitted.step("create")?.executed).toBe(true);
		// Still exactly the two dry runs on the wire — the client never submitted.
		expect(seen).toHaveLength(2);
		expect(seen.every((r) => r.headers.precognition === "true")).toBe(true);
	});
});
