// Fastify host adapter. One `register` call mounts every workflow that has an HTTP trigger.
// There is no route table to edit.
import type { FastifyInstance } from "fastify";
import { BlokError, type Call, type HttpBinding, type Log, type Span, blok } from "./kernel.ts";
import { type ProjectOptions, loadProject } from "./project.ts";

const STATUS: Record<string, number> = { invalid_input: 400, not_implemented: 501 };

/** Mounts one binding as a route. */
export function mount(app: FastifyInstance, binding: HttpBinding, call: Call): void {
	app.route({
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
			try {
				return await call(binding.unit, request);
			} catch (err) {
				if (!(err instanceof BlokError)) throw err;
				const status = binding.status?.[err.code] ?? STATUS[err.code] ?? 500;
				return reply.code(status).send({ error: err.code, message: err.message, node: err.node });
			}
		},
	});
}

export interface BlokFastifyOptions extends ProjectOptions {
	/** What the nodes reach the outside world through. */
	ports: unknown;
	log?: Log;
	/** Called once for every node and workflow that ran. */
	onSpan?: (span: Span) => void;
}

/**
 * The plugin: `await app.register(blokFastify, { dir: import.meta.dirname, ports })`.
 * It loads the nodes and the built workflows, checks them, and mounts the HTTP triggers.
 */
export async function blokFastify(app: FastifyInstance, options: BlokFastifyOptions): Promise<void> {
	const project = await loadProject(options);
	const { call } = blok<unknown>().runtime({ ports: options.ports, log: options.log, onSpan: options.onSpan });
	for (const binding of project.bindings) mount(app, binding, call);
}
