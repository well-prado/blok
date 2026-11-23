// Express host adapter: `app.use(await blokExpress({ dir: import.meta.dirname, ports }))`.
import express, { type Request, type RequestHandler, type Router } from "express";
import { type AnswerOptions, answer } from "./http.ts";
import type { Call, HttpBinding } from "./kernel.ts";
import { type App, type AppOptions, ready } from "./project.ts";

const RAW = new WeakMap<Request, string>();
// Parses a JSON body and keeps it as it arrived, which a signed route needs. When the app parsed the
// body before this route saw the request, there is nothing left to keep.
const json = express.json({ verify: (req, _res, buffer) => void RAW.set(req as Request, buffer.toString("utf8")) });
const parse: RequestHandler = (req, res, next) =>
	json(req, res, (err?: unknown) => {
		if ((err as { type?: string } | undefined)?.type !== "entity.parse.failed") return next(err);
		// A body that is not JSON is the caller's mistake, and is answered the way every other one is.
		res.status(400).json({ error: "invalid_input", message: "The body is not JSON." });
	});

/** Mounts one binding as a route on a router or an app you already have. */
export function mount(router: Router, binding: HttpBinding, call: Call, options: AnswerOptions = {}): void {
	const method = binding.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
	router[method](binding.path, parse, async (req, res) => {
		const request = {
			method: req.method,
			body: req.body ?? {},
			query: req.query,
			params: req.params,
			headers: req.headers,
		};
		const result = await answer(binding, call, request, { ...options, raw: RAW.get(req) });
		res
			.status(result.status)
			.type("application/json")
			.send(JSON.stringify(result.body ?? null));
	});
}

/**
 * A router with one route per workflow that has an HTTP trigger. Use it before `express.json()`,
 * so that a signed webhook can still be checked against the bytes that arrived.
 */
export async function blokExpress(source: App | AppOptions): Promise<Router> {
	const { bindings, call, log } = await ready(source);
	const router = express.Router();
	for (const binding of bindings) if (binding.kind === "http") mount(router, binding, call, { log });
	return router;
}
