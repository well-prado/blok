// Hono host adapter: `app.route("/", await blokHono({ dir: import.meta.dirname, ports }))`.
import { Hono } from "hono";
import { type AnswerOptions, answer } from "./http.ts";
import type { Call, HttpBinding } from "./kernel.ts";
import { type App, type AppOptions, ready } from "./project.ts";

const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body ?? null), { status, headers: { "content-type": "application/json" } });

/** Mounts one binding as a route on a Hono app you already have. */
export function mount(app: Hono, binding: HttpBinding, call: Call, options: AnswerOptions = {}): void {
	app.on(binding.method, binding.path, async (c) => {
		const raw = c.req.method === "GET" ? "" : await c.req.text();
		let body: unknown = {};
		if (raw !== "") {
			try {
				body = JSON.parse(raw);
			} catch {
				return json({ error: "invalid_input", message: "The body is not JSON." }, 400);
			}
		}
		// A key given once is text, and a key given several times is a list, as the other servers have it.
		const query = Object.fromEntries(
			Object.entries(c.req.queries()).map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
		);
		const request = { method: c.req.method, body, query, params: c.req.param(), headers: c.req.header() };
		const result = await answer(binding, call, request, { ...options, raw });
		return json(result.body, result.status);
	});
}

/** A Hono app with one route per workflow that has an HTTP trigger. Mount it where you like. */
export async function blokHono(source: App | AppOptions): Promise<Hono> {
	const { bindings, call, log } = await ready(source);
	const app = new Hono();
	for (const binding of bindings) if (binding.kind === "http") mount(app, binding, call, { log });
	return app;
}
