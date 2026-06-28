import type { HttpTriggerOpts } from "@blokjs/helper";

/**
 * The trigger config block a workflow's `opts.trigger` expects for an HTTP
 * route: `{ http: { method, path, ... } }`. `workflow()` reads this verbatim.
 */
export type HttpTriggerBlock = { http: HttpTriggerOpts };

/** Extra HTTP trigger options (concurrency/scheduling/headers/etc.) minus the bits the helper sets. */
type HttpOpts = Omit<HttpTriggerOpts, "method" | "path">;

const make =
	(method: HttpTriggerOpts["method"]) =>
	(path?: string, opts?: HttpOpts): HttpTriggerBlock => ({
		http: { method, ...(path !== undefined ? { path } : {}), ...opts },
	});

/**
 * Tiny trigger-config builder for the handle DSL: `trigger: http.post("/orders")`.
 * Each method returns the `{ http: { method, path, ...opts } }` block the
 * callback `workflow()` reads from `opts.trigger`. `path` is optional —
 * omit it for file-based routing. `any()` is the wildcard ("ANY").
 */
export const http = {
	get: make("GET"),
	post: make("POST"),
	put: make("PUT"),
	delete: make("DELETE"),
	patch: make("PATCH"),
	any: make("ANY"),
} as const;
