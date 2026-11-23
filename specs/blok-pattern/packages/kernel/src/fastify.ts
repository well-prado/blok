// Fastify host adapter. One `register` call mounts every workflow that has an HTTP trigger.
// There is no route table to edit.
import type { FastifyInstance } from "fastify";
import { type AnswerOptions, answer } from "./http.ts";
import type { Call, HttpBinding } from "./kernel.ts";
import { type App, type AppOptions, ready } from "./project.ts";

const RAW = new WeakMap<object, string>();

/** Mounts one binding as a route on a server you already have. */
export function mount(app: FastifyInstance, binding: HttpBinding, call: Call, options: AnswerOptions = {}): void {
	const route = (scope: FastifyInstance) =>
		scope.route({
			method: binding.method,
			url: binding.path,
			handler: async (req, reply) => {
				const request = {
					method: req.method,
					body: req.body ?? {},
					query: req.query,
					params: req.params,
					headers: req.headers,
				};
				const result = await answer(binding, call, request, { ...options, raw: RAW.get(req) });
				return reply
					.code(result.status)
					.type("application/json")
					.send(JSON.stringify(result.body ?? null));
			},
		});
	if (!binding.signature) return void route(app);
	// A signature is made over the bytes that arrived, so a signed route keeps them. It gets a scope of
	// its own for that, and the server's other routes parse their bodies as before.
	app.register(async (scope) => {
		const parse = scope.getDefaultJsonParser("error", "error");
		scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
			RAW.set(req, body as string);
			parse(req, body as string, done);
		});
		route(scope);
	});
}

/**
 * The plugin: `await app.register(blokFastify, { dir: import.meta.dirname, ports })`.
 * It loads the nodes and the built workflows, checks them, and mounts the HTTP triggers.
 * An app that also runs schedules or queues loads once with `loadApp` and passes that instead.
 */
export async function blokFastify(app: FastifyInstance, source: App | AppOptions): Promise<void> {
	const { bindings, call, log } = await ready(source);
	for (const binding of bindings) if (binding.kind === "http") mount(app, binding, call, { log });
}

export type BlokFastifyOptions = App | AppOptions;
