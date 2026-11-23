// Runs every workflow that has a queue trigger, once per message. The queue itself is yours:
// `subscribe` is the one function that connects a broker to Blok.
//
//     await startQueues(app, {
//       subscribe: (queue, handle, { concurrency }) => new Worker(queue, (job) => handle(job.data), { concurrency }),
//     });
//
// A message is handed over at least once, as every broker does it, so the nodes it reaches must be
// safe to run twice with the same message.
import { BlokError, type QueueBinding, mayWorkLater } from "./kernel.ts";
import { type App, type AppOptions, ready } from "./project.ts";

/** Handles one message. It throws when the message should be handed over again, and returns when it is dealt with. */
export type Handler = (message: unknown) => Promise<void>;
/** Connects one queue of your broker to its handler. May return a function that disconnects it. */
export type Subscribe = (queue: string, handle: Handler, options: { concurrency?: number }) => unknown;

/** A message the workflow refused for good, so that sending it again would only be refused again. */
export interface Refused {
	queue: string;
	/** The workflow. */
	id: string;
	message: unknown;
	error: BlokError;
}
export interface QueueOptions {
	subscribe: Subscribe;
	/**
	 * Called with each message a workflow refuses: one that lacks a field, or one a step fails on with a
	 * business error. Put it where a person will see it. Left out, it is written to the log and dropped.
	 */
	onRefused?: (refused: Refused) => void | Promise<void>;
}

export async function startQueues(
	source: App | AppOptions,
	options: QueueOptions,
): Promise<{ queues: string[]; stop(): Promise<void> }> {
	const { bindings, call, log } = await ready(source);
	const queues = bindings.filter((binding): binding is QueueBinding => binding.kind === "queue");
	const stops: unknown[] = [];
	for (const binding of queues) {
		const handle: Handler = async (message) => {
			try {
				await call(binding.unit, { body: message });
			} catch (err) {
				const error = err instanceof BlokError ? err : new BlokError("unexpected", String(err), binding.unit.id);
				const said = `${binding.unit.id}, on a message from "${binding.queue}", failed with "${error.code}" at ${error.node}: ${error.message}`;
				// The broker hands the message over again, which may work: this failure was not about the message.
				if (mayWorkLater(error.code)) {
					log.error(said);
					throw error;
				}
				if (options.onRefused) {
					await options.onRefused({ queue: binding.queue, id: binding.unit.id, message, error });
				} else log.error(`${said} The message was dropped: sending it again would be refused again.`);
			}
		};
		stops.push(await options.subscribe(binding.queue, handle, { concurrency: binding.concurrency }));
	}
	return {
		queues: queues.map((binding) => binding.queue),
		async stop() {
			for (const stop of stops) if (typeof stop === "function") await stop();
		},
	};
}

/**
 * A queue that lives in this process, for development and for tests. It gives the app a queue to run on
 * until a real one exists, as the in-memory ports do. Nothing in it survives a restart.
 */
export function memoryQueue(options: { attempts?: number } = {}) {
	const attempts = options.attempts ?? 3;
	const waiting = new Map<string, unknown[]>();
	const handlers = new Map<string, { handle: Handler; limit: number; busy: number }>();
	/** Messages that failed on every attempt. A real broker would move them to a dead-letter queue. */
	const dead: Array<{ queue: string; message: unknown; error: unknown }> = [];
	let active = 0;
	const settled: Array<() => void> = [];

	const pump = (queue: string) => {
		const handler = handlers.get(queue);
		const messages = waiting.get(queue) ?? [];
		while (handler && handler.busy < handler.limit && messages.length > 0) {
			const message = messages.shift();
			handler.busy++;
			active++;
			void (async () => {
				for (let attempt = 1; ; attempt++) {
					try {
						await handler.handle(message);
						break;
					} catch (error) {
						if (attempt < attempts) continue;
						dead.push({ queue, message, error });
						break;
					}
				}
				handler.busy--;
				active--;
				pump(queue);
				if (active === 0 && [...waiting.values()].every((left) => left.length === 0)) {
					for (const done of settled.splice(0)) done();
				}
			})();
		}
	};

	return {
		dead,
		/** Puts a message on a queue. It waits there until something subscribes. */
		send(queue: string, message: unknown): void {
			waiting.set(queue, [...(waiting.get(queue) ?? []), structuredClone(message)]);
			// Not now: whoever sent it finishes first, as with a real queue.
			queueMicrotask(() => pump(queue));
		},
		subscribe: ((queue, handle, { concurrency }) => {
			handlers.set(queue, { handle, limit: concurrency ?? 1, busy: 0 });
			pump(queue);
			return () => void handlers.delete(queue);
		}) satisfies Subscribe,
		/** Resolves when every message that has a subscriber has been handled. */
		idle(): Promise<void> {
			const pending = [...waiting].some(([queue, left]) => left.length > 0 && handlers.has(queue));
			if (active === 0 && !pending) return Promise.resolve();
			return new Promise((done) => settled.push(done));
		},
	};
}
