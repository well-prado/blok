// The three HTTP adapters answer the same request the same way, and a signed route refuses what is not signed.
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { z } from "zod";
import { mount as mountExpress } from "../src/express.ts";
import { mount as mountFastify } from "../src/fastify.ts";
import { mount as mountHono } from "../src/hono.ts";
import { signed } from "../src/http.ts";
import {
	type HttpBinding,
	type Unit,
	type Workflow,
	blok,
	checkWorkflow,
	httpBinding,
	loadWorkflows,
} from "../src/index.ts";

// ---- signatures --------------------------------------------------------------------------

const hex = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest("hex");

// A secret made up for these tests. It is built from a sentence when they run, so no line here reads as a real one.
const SECRET = `whsec_${Buffer.from("a secret made up for these tests").toString("base64")}`;
const NOW = 1_800_000_000;

/** What a sender of Standard Webhooks puts on a request, made with Node's own HMAC. */
function sign(body: string, at = NOW, id = "msg_1"): Record<string, string> {
	const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
	const signature = createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64");
	return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${signature}` };
}

test("a signature is accepted only when the secret and the body produce it", async () => {
	// The example from GitHub's documentation.
	const github = { scheme: "github", secret: "It's a Secret to Everybody" } as const;
	const githubHeader = {
		"x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
	};
	expect(await signed(github, "Hello, World!", githubHeader)).toBe(true);
	expect(await signed(github, "Hello, World?", githubHeader)).toBe(false);
	expect(await signed({ ...github, secret: "another secret" }, "Hello, World!", githubHeader)).toBe(false);
	expect(await signed(github, "Hello, World!", {})).toBe(false);
	expect(await signed(github, "Hello, World!", { "x-hub-signature-256": "sha256=not-hex" })).toBe(false);
	expect(await signed(github, "Hello, World!", { "x-hub-signature-256": "757107ea" })).toBe(false);
	// The bytes are what is signed, however they are handed over.
	expect(await signed(github, new TextEncoder().encode("Hello, World!"), githubHeader)).toBe(true);

	// Standard Webhooks: the secret is base64 after "whsec_", and the id, the time and the body are what is signed.
	// Checked against Node's own HMAC.
	const standard = { scheme: "standard", secret: SECRET } as const;
	const sent = 1614265330;
	const body = '{"test": 2432232314}';
	const headers = sign(body, sent);
	expect(await signed(standard, body, headers, sent * 1000)).toBe(true);
	expect(await signed(standard, '{"test": 2432232315}', headers, sent * 1000)).toBe(false);
	expect(await signed(standard, body, { ...headers, "webhook-id": "msg_other" }, sent * 1000)).toBe(false);
	const other = `whsec_${Buffer.from("another secret").toString("base64")}`;
	expect(await signed({ ...standard, secret: other }, body, headers, sent * 1000)).toBe(false);
	// The same request five minutes later still counts, and six minutes later it is a recording played back.
	expect(await signed(standard, body, headers, (sent + 5 * 60) * 1000)).toBe(true);
	expect(await signed(standard, body, headers, (sent + 6 * 60) * 1000)).toBe(false);
	expect(await signed(standard, body, headers, (sent - 6 * 60) * 1000)).toBe(false);
	// While a sender changes its secret it sends two signatures. One that matches is enough.
	const two = { ...headers, "webhook-signature": `v1,AAAA v1a,ignored ${headers["webhook-signature"]}` };
	expect(await signed(standard, body, two, sent * 1000)).toBe(true);
	expect(await signed(standard, body, { ...headers, "webhook-timestamp": "yesterday" }, sent * 1000)).toBe(false);

	// Stripe signs the time and the body with the secret as it is written. Checked against Node's own HMAC.
	const stripe = { scheme: "stripe", secret: "whsec_test_secret" } as const;
	const event = '{"id":"evt_1","type":"charge.succeeded"}';
	const v1 = hex(stripe.secret, `${sent}.${event}`);
	const stripeHeader = { "stripe-signature": `t=${sent},v1=${v1},v0=ignored` };
	expect(await signed(stripe, event, stripeHeader, sent * 1000)).toBe(true);
	expect(await signed(stripe, `${event} `, stripeHeader, sent * 1000)).toBe(false);
	expect(await signed(stripe, event, stripeHeader, (sent + 301) * 1000)).toBe(false);
	expect(await signed(stripe, event, { "stripe-signature": `v1=${v1}` }, sent * 1000)).toBe(false);

	// A bare HMAC in a header the sender chose, in base64, as Shopify sends it.
	const plain = { scheme: "hmac", secret: "shop-secret", header: "X-Shop-Hmac-Sha256", encoding: "base64" } as const;
	const digest = createHmac("sha256", plain.secret).update(event).digest("base64");
	expect(await signed(plain, event, { "x-shop-hmac-sha256": digest })).toBe(true);
	expect(await signed(plain, event, { "x-shop-hmac-sha256": digest.replace(/.$/, "A") })).toBe(false);
	// The default is hex, and a prefix is taken off first.
	const prefixed = { scheme: "hmac", secret: "s", header: "x-sig", prefix: "v0=" } as const;
	expect(await signed(prefixed, event, { "x-sig": `v0=${hex("s", event)}` })).toBe(true);
	expect(await signed(prefixed, event, { "x-sig": hex("s", event) })).toBe(false);
});

// ---- the same answers from Fastify, Hono and Express --------------------------------------

interface Ports {
	seen: string[];
}
const { node, runtime } = blok<Ports>();

const price = node({
	id: "shop/price@1",
	input: z.object({
		sku: z.string(),
		quantity: z.number().int().positive(),
		gift: z.boolean().default(false),
		tags: z.array(z.string()).default([]),
	}),
	output: z.object({ sku: z.string(), cents: z.number().int(), gift: z.boolean(), tags: z.array(z.string()) }),
	errors: { unknown_sku: "Nothing with that name is sold." },
	run({ sku, quantity, gift, tags }, { fail }) {
		if (sku !== "book") throw fail("unknown_sku", `There is no "${sku}".`);
		return { sku, cents: 2500 * quantity, gift, tags };
	},
});
const crash = node({
	id: "shop/crash@1",
	input: z.object({}),
	output: z.object({}),
	run() {
		throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
	},
});
const record = node({
	id: "shop/record@1",
	input: z.object({ id: z.string(), type: z.string() }),
	output: z.object({ recorded: z.string() }),
	run({ id, type }, { ports }) {
		ports.seen.push(id);
		return { recorded: `${type}:${id}` };
	},
});

const workflows: Record<string, Workflow> = {
	// Everything a query string and a path can carry: text, a number, true/false and a list.
	quote: {
		name: "Quote",
		trigger: { http: { method: "GET", path: "/shops/:shop/prices/:sku", errors: { unknown_sku: 404 } } },
		steps: [
			{
				name: "price",
				node: "shop/price@1",
				inputs: {
					sku: "${request.params.sku}",
					quantity: "${request.query.quantity}",
					gift: "${request.query.gift}",
					tags: "${request.query.tag}",
				},
			},
		],
		result: { shop: "${request.params.shop}", price: "${price}" },
	},
	order: {
		name: "Order",
		trigger: { http: { method: "POST", path: "/orders", status: 201, errors: { unknown_sku: 404 } } },
		steps: [
			{
				name: "price",
				node: "shop/price@1",
				inputs: { sku: "${request.body.sku}", quantity: "${request.body.quantity}" },
			},
		],
	},
	crash: {
		name: "Crash",
		trigger: { http: { method: "POST", path: "/crash" } },
		steps: [{ name: "crash", node: "shop/crash@1" }],
	},
	hook: {
		name: "Hook",
		trigger: {
			http: {
				method: "POST",
				path: "/hooks/payments",
				status: 202,
				signature: { scheme: "standard", secret: "PAYMENTS_SECRET" },
			},
		},
		steps: [
			{ name: "event", node: "shop/record@1", inputs: { id: "${request.body.id}", type: "${request.body.type}" } },
		],
	},
};

interface Sent {
	method: string;
	url: string;
	body?: string;
	headers?: Record<string, string>;
}
type Send = (request: Sent) => Promise<[status: number, type: string, body: unknown]>;

/** The same four routes on each server, and one way to send a request to it. */
function servers() {
	const units = new Map<string, Unit>([price, crash, record].map((unit) => [unit.id, unit]));
	const list = Object.entries(workflows).map(([name, workflow]) => ({ id: `workflows/${name}@1`, workflow }));
	loadWorkflows(list, units);
	const bindings = list.map(
		({ id, workflow }) => httpBinding(workflow, units.get(id) as Unit, { PAYMENTS_SECRET: SECRET }) as HttpBinding,
	);
	const seen: Record<string, string[]> = { fastify: [], hono: [], express: [] };
	const logged: Record<string, string[]> = { fastify: [], hono: [], express: [] };
	const options = (name: string) => ({
		log: { info() {}, error: (message: string) => void logged[name].push(message) },
		now: () => NOW * 1000,
	});
	const call = (name: string) => runtime({ ports: { seen: seen[name] } }).call;
	const json = (headers: Record<string, string> = {}, body?: string) =>
		body === undefined ? headers : { "content-type": "application/json", ...headers };

	const fastify = Fastify();
	for (const binding of bindings) mountFastify(fastify, binding, call("fastify"), options("fastify"));
	const viaFastify: Send = async ({ method, url, body, headers }) => {
		const res = await fastify.inject({ method: method as "GET", url, payload: body, headers: json(headers, body) });
		return [res.statusCode, String(res.headers["content-type"]).split(";")[0], res.json()];
	};

	const hono = new Hono();
	for (const binding of bindings) mountHono(hono, binding, call("hono"), options("hono"));
	const viaHono: Send = async ({ method, url, body, headers }) => {
		const res = await hono.request(url, { method, body, headers: json(headers, body) });
		return [res.status, String(res.headers.get("content-type")).split(";")[0], await res.json()];
	};

	const app = express();
	for (const binding of bindings) mountExpress(app, binding, call("express"), options("express"));
	const listening = app.listen(0);
	const viaExpress: Send = async ({ method, url, body, headers }) => {
		const port = (listening.address() as AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, body, headers: json(headers, body) });
		return [res.status, String(res.headers.get("content-type")).split(";")[0], await res.json()];
	};

	return {
		send: { fastify: viaFastify, hono: viaHono, express: viaExpress },
		seen,
		logged,
		close: () => listening.close(),
	};
}

test("Fastify, Hono and Express give the same answer to the same request", async () => {
	const { send, seen, logged, close } = servers();
	const event = '{"id":"evt_1","type":"payment.succeeded"}';
	const cases: Array<[what: string, request: Sent, status: number, body: unknown]> = [
		[
			"a query string is text, and becomes the number, the true/false and the list the node asks for",
			{ method: "GET", url: "/shops/s1/prices/book?quantity=2&gift=true&tag=new&tag=sale" },
			200,
			{ shop: "s1", price: { sku: "book", cents: 5000, gift: true, tags: ["new", "sale"] } },
		],
		[
			"one value where a list is asked for is a list of one, and what is left out takes its default",
			{ method: "GET", url: "/shops/s1/prices/book?quantity=1&tag=new" },
			200,
			{ shop: "s1", price: { sku: "book", cents: 2500, gift: false, tags: ["new"] } },
		],
		[
			"text that is not a number stays text, and the node refuses it",
			{ method: "GET", url: "/shops/s1/prices/book?quantity=two" },
			400,
			{ error: "invalid_input", message: "Invalid input: expected number, received string", node: "shop/price@1" },
		],
		[
			"a missing field is refused before any step runs",
			{ method: "GET", url: "/shops/s1/prices/book" },
			400,
			{ error: "invalid_input", message: "The request is missing: query.quantity.", node: "workflows/quote@1" },
		],
		[
			"a business error gets the status the trigger gives it",
			{ method: "GET", url: "/shops/s1/prices/desk?quantity=1" },
			404,
			{ error: "unknown_sku", message: 'There is no "desk".', node: "shop/price@1" },
		],
		[
			"a create answers with the status the trigger names",
			{ method: "POST", url: "/orders", body: '{"sku":"book","quantity":3}' },
			201,
			{ sku: "book", cents: 7500, gift: false, tags: [] },
		],
		[
			"a body that is not JSON is the caller's mistake",
			{ method: "POST", url: "/orders", body: '{"sku":' },
			400,
			undefined,
		],
		[
			"a failure nobody planned for says nothing about what broke",
			{ method: "POST", url: "/crash", body: "{}" },
			500,
			{ error: "unexpected", message: "The server could not complete the request." },
		],
		[
			"a signed webhook is let in",
			{ method: "POST", url: "/hooks/payments", body: event, headers: sign(event) },
			202,
			{ recorded: "payment.succeeded:evt_1" },
		],
		[
			"a webhook whose body was changed on the way is refused",
			{ method: "POST", url: "/hooks/payments", body: event.replace("evt_1", "evt_2"), headers: sign(event) },
			401,
			{ error: "invalid_signature", message: "The signature does not match." },
		],
		[
			"a webhook with no signature is refused",
			{ method: "POST", url: "/hooks/payments", body: event },
			401,
			{ error: "invalid_signature", message: "The signature does not match." },
		],
		[
			"a webhook recorded ten minutes ago and sent again is refused",
			{ method: "POST", url: "/hooks/payments", body: event, headers: sign(event, NOW - 600) },
			401,
			{ error: "invalid_signature", message: "The signature does not match." },
		],
	];
	for (const [what, request, status, body] of cases) {
		for (const [name, via] of Object.entries(send)) {
			const [gotStatus, type, got] = await via(request);
			// The message of a broken body is each server's own. That it is a 400 in JSON is what they share.
			const shown = body === undefined ? undefined : got;
			expect({ what, name, status: gotStatus, type, body: shown }).toEqual({
				what,
				name,
				status,
				type: "application/json",
				body,
			});
		}
	}
	// Only the signed request reached the node, on every server.
	expect(seen).toEqual({ fastify: ["evt_1"], hono: ["evt_1"], express: ["evt_1"] });
	// What broke is in the log, where the people who run the server read it.
	const line = 'workflows/crash@1 failed with "unexpected" at shop/crash@1: connect ECONNREFUSED 10.0.0.5:5432';
	expect(logged).toEqual({ fastify: [line], hono: [line], express: [line] });
	close();
});

test("a signed route on Fastify keeps the server's other routes as they were", async () => {
	const { send } = servers();
	// The unsigned routes still parse JSON the server's own way, including a body the signed scope never saw.
	expect(await send.fastify({ method: "POST", url: "/orders", body: '{"sku":"book","quantity":1}' })).toEqual([
		201,
		"application/json",
		{ sku: "book", cents: 2500, gift: false, tags: [] },
	]);
});

test("Express says so when the body was parsed before Blok saw it, and never lets the request through", async () => {
	const units = new Map<string, Unit>([record].map((unit) => [unit.id, unit]));
	const [unit] = loadWorkflows([{ id: "workflows/hook@1", workflow: workflows.hook }], units);
	const logged: string[] = [];
	const seen: string[] = [];
	const app = express();
	app.use(express.json());
	mountExpress(
		app,
		httpBinding(workflows.hook, unit, { PAYMENTS_SECRET: SECRET }) as HttpBinding,
		runtime({ ports: { seen } }).call,
		{
			log: { info() {}, error: (message) => void logged.push(message) },
			now: () => NOW * 1000,
		},
	);
	const listening = app.listen(0);
	const event = '{"id":"evt_1","type":"payment.succeeded"}';
	const res = await fetch(`http://127.0.0.1:${(listening.address() as AddressInfo).port}/hooks/payments`, {
		method: "POST",
		body: event,
		headers: { "content-type": "application/json", ...sign(event) },
	});
	expect(res.status).toBe(500);
	expect(seen).toEqual([]);
	expect(logged).toEqual([
		"workflows/hook@1 checks a signature, and the body as it arrived was gone before Blok saw the request. Mount Blok before anything that parses the body.",
	]);
	listening.close();
});

test("a signed trigger needs its secret when the project loads, and the check knows what a signature needs", () => {
	const units = new Map<string, Unit>([record].map((unit) => [unit.id, unit]));
	const [unit] = loadWorkflows([{ id: "workflows/hook@1", workflow: workflows.hook }], units);
	expect(() => httpBinding(workflows.hook, unit)).toThrow(
		"workflows/hook@1 checks a signature with the secret in PAYMENTS_SECRET, and no such value was given. Pass it in `env`, for example `env: process.env`.",
	);
	// The secret is in the binding and nowhere in the workflow.
	expect(httpBinding(workflows.hook, unit, { PAYMENTS_SECRET: SECRET })?.signature).toEqual({
		scheme: "standard",
		secret: SECRET,
	});

	const shapes = () => ({ input: { type: "object", properties: {} }, output: { type: "object", properties: {} } });
	const wrong: Workflow = {
		name: "Wrong",
		trigger: { http: { method: "GET", path: "/hooks", signature: { scheme: "hmac", secret: "SECRET" } } },
		steps: [{ name: "event", node: "shop/any@1" }],
	};
	expect(checkWorkflow(wrong, shapes).problems).toEqual([
		"A signature is made over the body of a request, and a GET has none. Make the trigger a POST.",
		'A signature with the scheme "hmac" needs "header": the header that carries the signature.',
	]);
});
