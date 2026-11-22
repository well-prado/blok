// The example app started every way a workflow can be started: by a signed webhook, a queue message,
// a schedule and an agent's tool call. Real nodes, fake ports.
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startCron } from "@blokjs/kernel/cron";
import { blokMcp } from "@blokjs/kernel/mcp";
import { memoryQueue, startQueues } from "@blokjs/kernel/queue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Validator } from "@seriousme/openapi-schema-validator";
import { build, locate } from "blokctl";
import { type Ports, paymentEventsOn } from "#ports";
import { DEV_SECRET, buildApp, fakePorts, loadBlok } from "../app.ts";

const root = join(import.meta.dirname, "..");
// The app loads what `blokctl build` wrote, as it does in production.
const built = await build(locate(root));
if (!built.ok) throw new Error(built.text);

function sign(body: string, id = "msg_1", at = Math.floor(Date.now() / 1000)): Record<string, string> {
	const key = Buffer.from(DEV_SECRET.slice("whsec_".length), "base64");
	const signature = createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64");
	return {
		"content-type": "application/json",
		"webhook-id": id,
		"webhook-timestamp": String(at),
		"webhook-signature": `v1,${signature}`,
	};
}

/** A key-value port that remembers every write, in order. */
function memoryKv() {
	const writes: Array<[string, unknown]> = [];
	const kv: Ports["kv"] = {
		set: async (key, value) => void writes.push([key, value]),
		list: async () => writes.map(([, value]) => value),
	};
	return { kv, writes };
}

test("a signed webhook is answered at once, and the queue applies the event once however often it arrives", async () => {
	const queue = memoryQueue();
	const { kv, writes } = memoryKv();
	const blok = await loadBlok(fakePorts({ kv, paymentEvents: paymentEventsOn(queue) }));
	const app = await buildApp(blok);
	const { queues } = await startQueues(blok, { subscribe: queue.subscribe });
	expect(queues).toEqual(["payment-events"]);

	const event = JSON.stringify({ id: "evt_1", type: "payment.succeeded", orderId: "o_1", amountCents: 5000 });
	const send = (payload: string, headers: Record<string, string>) =>
		app.inject({ method: "POST", url: "/webhooks/payments", payload, headers });

	const accepted = await send(event, sign(event));
	expect([accepted.statusCode, accepted.json()]).toEqual([202, { accepted: true }]);
	await queue.idle();
	expect(writes).toEqual([["payment:o_1", { status: "paid", amountCents: 5000 }]]);

	// The provider did not see our answer in time and sends the same event again. It is taken, and changes nothing.
	expect((await send(event, sign(event, "msg_2"))).statusCode).toBe(202);
	await queue.idle();
	expect(writes).toHaveLength(1);

	// Somebody who does not hold the secret cannot mark an order as paid.
	const forged = JSON.stringify({ id: "evt_2", type: "payment.succeeded", orderId: "o_2", amountCents: 1 });
	const unsigned = await send(forged, { "content-type": "application/json" });
	expect([unsigned.statusCode, unsigned.json().error]).toEqual([401, "invalid_signature"]);
	const altered = await send(forged, sign(event));
	expect(altered.statusCode).toBe(401);
	// A signed event that lacks a field is refused before it reaches the queue.
	const partial = JSON.stringify({ id: "evt_3", type: "payment.failed" });
	const refused = await send(partial, sign(partial));
	expect([refused.statusCode, refused.json().message]).toEqual([
		400,
		"The request is missing: body.orderId, body.amountCents.",
	]);
	await queue.idle();
	expect(writes).toHaveLength(1);
	expect(queue.dead).toEqual([]);
});

test("the nightly catalog sync runs on its schedule, and can still be started by hand", async () => {
	const { kv, writes } = memoryKv();
	// The supplier's catalog, two pages long.
	const http: Ports["http"] = {
		request: async ({ url }) => {
			const page = Number(new URL(url).searchParams.get("page"));
			const next = page < 2 ? `https://supplier.example/catalog?page=${page + 1}` : null;
			return { status: 200, data: { items: [`sku-${page}`], next } };
		},
	};
	const blok = await loadBlok(fakePorts({ kv, http }));
	let now = Date.parse("2026-03-10T02:59:30Z");
	const due: Array<() => void> = [];
	const timers = { now: () => now, set: (run: () => void) => due.push(run), clear() {} };
	const ran: string[] = [];
	const cron = await startCron(blok, {
		timers,
		onRun: (run) => ran.push(`${run.id} ${run.at.toISOString()} ${run.ok}`),
	});
	expect(cron.jobs.map((job) => [job.id, job.schedule, job.timezone, job.next().toISOString()])).toEqual([
		["workflows/catalog-sync@1", "0 3 * * *", "UTC", "2026-03-10T03:00:00.000Z"],
	]);

	now += 60_000;
	due.shift()?.();
	await cron.stop();
	expect(ran).toEqual(["workflows/catalog-sync@1 2026-03-10T03:00:00.000Z true"]);
	expect(writes).toEqual([["catalog", ["sku-1", "sku-2"]]]);

	// The same workflow has a route.
	const app = await buildApp(blok);
	expect((await app.inject({ method: "POST", url: "/catalog/sync" })).statusCode).toBe(200);
	expect(writes).toHaveLength(2);
});

test("an agent can price a basket with the quote_order tool, and is told what is wrong when it cannot", async () => {
	const server = await blokMcp(await loadBlok(fakePorts()), { name: "shop", version: "1.0.0" });
	const client = new Client({ name: "test", version: "1.0.0" });
	const [near, far] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(far), client.connect(near)]);

	const { tools } = await client.listTools();
	expect(tools.map((tool) => tool.name)).toEqual(["quote_order"]);
	expect(tools[0].description).toBe("Prices a basket without placing an order. Give it items: a list of { sku, qty }.");
	// What the agent must send was never written down. It follows from the nodes the workflow wires its body into.
	expect(tools[0].inputSchema).toMatchObject({ type: "object", properties: { items: { type: "array" } } });

	const priced = await client.callTool({
		name: "quote_order",
		arguments: {
			items: [
				{ sku: "sku-book", qty: 2 },
				{ sku: "sku-desk", qty: 1 },
			],
		},
	});
	expect(priced.structuredContent).toMatchObject({ totalCents: 23000, lineCount: 2 });
	expect(
		await client.callTool({ name: "quote_order", arguments: { items: [{ sku: "sku-nope", qty: 1 }] } }),
	).toMatchObject({
		isError: true,
		content: [{ type: "text", text: expect.stringContaining("unknown_sku: ") }],
	});
	await client.close();
});

test("mcp.ts serves the same tool to an agent's program, over standard input and output", async () => {
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(
		new StdioClientTransport({ command: process.execPath, args: ["mcp.ts"], cwd: root, stderr: "pipe" }),
	);
	try {
		expect(client.getServerVersion()).toMatchObject({ name: "blok-pattern-prototype", version: "1.0.0" });
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["quote_order"]);
		const priced = await client.callTool({ name: "quote_order", arguments: { items: [{ sku: "sku-book", qty: 1 }] } });
		expect(priced.structuredContent).toMatchObject({ totalCents: 2500, lineCount: 1 });
	} finally {
		await client.close();
	}
}, 30_000);

test("the build describes every route of the example as OpenAPI, and a validator accepts it", async () => {
	const document = JSON.parse(readFileSync(join(root, ".blok", "openapi.json"), "utf8"));
	const checked = await new Validator().validate(structuredClone(document));
	expect(checked.errors ?? []).toEqual([]);
	expect(checked.valid).toBe(true);
	const routes = Object.entries(document.paths as Record<string, Record<string, unknown>>).flatMap(([path, methods]) =>
		Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
	);
	expect(routes.sort()).toEqual([
		"GET /countries",
		"GET /countries-or-facts",
		"GET /feedback",
		"POST /catalog/sync",
		"POST /feedback",
		"POST /fulfilments",
		"POST /orders",
		"POST /orders/place",
		"POST /quotes",
		"POST /webhooks/payments",
	]);
	// The checkout says what a declined card answers with, in the words the node wrote.
	expect(document.paths["/orders"].post.responses["402"].description).toStartWith("card_declined: ");
});
