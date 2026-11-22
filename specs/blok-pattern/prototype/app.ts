import { type App, type Span, loadApp } from "@blokjs/kernel";
import { startCron } from "@blokjs/kernel/cron";
import { blokFastify } from "@blokjs/kernel/fastify";
import { memoryQueue, startQueues } from "@blokjs/kernel/queue";
import Fastify from "fastify";
import { type Ports, fakePorts, paymentEventsOn } from "./ports/index.ts";

export { fakePorts };

/**
 * A secret for the example, so it starts with no setup. It is built from a sentence, so nobody takes it for
 * a real one. A real app has no default here: without the variable it refuses to start, which is what a
 * webhook that cannot check its signatures should do.
 */
export const DEV_SECRET = `whsec_${Buffer.from("for the example only, not a secret").toString("base64")}`;

/** Loads the project once. The server, the schedules, the queues and the tools all start from this. */
export const loadBlok = (ports: Ports, onSpan?: (s: Span) => void): Promise<App> =>
	loadApp({
		dir: import.meta.dirname,
		ports,
		onSpan,
		env: { PAYMENTS_WEBHOOK_SECRET: DEV_SECRET, ...process.env },
	});

export async function buildApp(blok: App) {
	const app = Fastify();
	// The one line that adds Blok to a Fastify server. It mounts every workflow that has an HTTP trigger.
	await app.register(blokFastify, blok);
	return app;
}

if (import.meta.main) {
	// A queue inside this process, until there is a real one. The port sends to it and the queue trigger reads from it.
	const queue = memoryQueue();
	const ports = fakePorts({ paymentEvents: paymentEventsOn(queue) });
	const blok = await loadBlok(ports, (s) =>
		console.log(`${s.ok ? "ok " : "ERR"} ${s.id.padEnd(28)} ${s.ms.toFixed(2)}ms${s.parent ? `  <- ${s.parent}` : ""}`),
	);
	const app = await buildApp(blok);
	const { jobs } = await startCron(blok);
	const { queues } = await startQueues(blok, { subscribe: queue.subscribe });
	console.log(await app.listen({ port: Number(process.env.PORT ?? 3000) }));
	for (const job of jobs) console.log(`schedule  ${job.id}  ${job.schedule}  next ${job.next().toISOString()}`);
	for (const name of queues) console.log(`queue     ${name}`);
}
