import type { Span } from "@blokjs/kernel";
import { blokFastify } from "@blokjs/kernel/fastify";
import Fastify from "fastify";
import { type Ports, fakePorts } from "./ports/index.ts";

export { fakePorts };

export async function buildApp(ports: Ports, onSpan?: (s: Span) => void) {
	const app = Fastify();
	// The one line that adds Blok to a Fastify server. It mounts every workflow that has an HTTP trigger.
	await app.register(blokFastify, { dir: import.meta.dirname, ports, onSpan });
	return app;
}

if (import.meta.main) {
	const app = await buildApp(fakePorts(), (s) =>
		console.log(`${s.ok ? "ok " : "ERR"} ${s.id.padEnd(28)} ${s.ms.toFixed(2)}ms${s.parent ? `  <- ${s.parent}` : ""}`),
	);
	console.log(await app.listen({ port: Number(process.env.PORT ?? 3000) }));
}
