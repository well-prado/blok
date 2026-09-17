import { describe, expect, it, vi } from "vitest";

// Keep the adapter contract tests independent of the generated workflow and
// node bundles. The production module still imports only HttpTrigger; this
// mock lets the test exercise its provider boundary with tiny fakes.
vi.mock("../../src/runner/HttpTrigger.js", () => ({
	default: class MockHttpTrigger {
		async prepare(): Promise<void> {}
		async fetch(): Promise<Response> {
			return new Response("mock");
		}
	},
}));

import { type ServerlessHttpTrigger, createBlokVercelHandler, createVercelHandler } from "../../src/serverless.js";

function triggerFor(response: Response | ((request: Request) => Response | Promise<Response>)) {
	let preparations = 0;
	const trigger: ServerlessHttpTrigger = {
		prepare: async () => {
			preparations++;
		},
		fetch: async (request) => (typeof response === "function" ? response(request) : response),
	};
	return { trigger, preparations: () => preparations };
}

describe("Vercel serverless HTTP adapter", () => {
	it("passes GET requests and responses through without a listener", async () => {
		const { trigger, preparations } = triggerFor(new Response("ok", { status: 200 }));
		const handler = createVercelHandler({ createTrigger: () => trigger });

		const response = await handler(new Request("https://example.test/health-check"));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(preparations()).toBe(1);
	});

	it.each([
		["JSON", "application/json", JSON.stringify({ name: "Ada" })],
		["form", "application/x-www-form-urlencoded", "name=Ada"],
		[
			"multipart",
			"multipart/form-data; boundary=blok",
			'--blok\r\nContent-Disposition: form-data; name="name"\r\n\r\nAda\r\n--blok--\r\n',
		],
	])("preserves %s request method, URL, headers, and body", async (_label, contentType, body) => {
		const received: Request[] = [];
		const { trigger } = triggerFor((request) => {
			received.push(request);
			return Response.json({ method: request.method, url: request.url });
		});
		const handler = createVercelHandler({ createTrigger: () => trigger });

		const response = await handler(
			new Request("https://example.test/forms?from=test", {
				method: "POST",
				headers: { "content-type": contentType, cookie: "session=opaque" },
				body,
			}),
		);

		expect(response.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].method).toBe("POST");
		expect(received[0].url).toBe("https://example.test/forms?from=test");
		expect(received[0].headers.get("cookie")).toBe("session=opaque");
		expect(await received[0].text()).toBe(body);
	});

	it("single-flights initialization and reuses the warm instance", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let preparations = 0;
		const modes: Array<"server" | "serverless" | undefined> = [];
		const trigger: ServerlessHttpTrigger = {
			prepare: async (mode) => {
				preparations++;
				modes.push(mode);
				await gate;
			},
			fetch: async () => new Response("ready"),
		};
		const handler = createVercelHandler({ createTrigger: () => trigger });

		const first = handler(new Request("https://example.test/one"));
		const second = handler(new Request("https://example.test/two"));
		await Promise.resolve();
		expect(preparations).toBe(1);
		expect(modes).toEqual(["serverless"]);
		release();

		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		await handler(new Request("https://example.test/warm"));
		expect(preparations).toBe(1);
	});

	it("returns structured 503 and logs when initialization fails", async () => {
		const logError = vi.fn();
		const trigger: ServerlessHttpTrigger = {
			prepare: async () => {
				throw new Error("configuration unavailable");
			},
			fetch: async () => new Response("never"),
		};
		const handler = createVercelHandler({ createTrigger: () => trigger, logError });

		const response = await handler(new Request("https://example.test/cold"));
		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			error: "BLOK serverless initialization failed",
			code: "BLOK_SERVERLESS_INIT_FAILED",
			failure: "Error",
		});
		expect(logError).toHaveBeenCalledWith("blok.serverless.initialization_failed", expect.any(Error));
	});

	it("redacts initialization details from the provider response", async () => {
		const logError = vi.fn();
		const handler = createVercelHandler({
			createTrigger: () => ({
				prepare: async () => {
					throw new Error("DATABASE_URL=super-secret");
				},
				fetch: async () => new Response("never"),
			}),
			logError,
		});
		const response = await handler(new Request("https://example.test/cold"));
		const body = await response.text();
		expect(response.status).toBe(503);
		expect(body).not.toContain("super-secret");
		expect(logError).toHaveBeenCalledWith("blok.serverless.initialization_failed", expect.any(Error));
	});

	it("exposes the documented Blok Vercel factory alias", async () => {
		const { trigger } = triggerFor(new Response("alias"));
		const handler = createBlokVercelHandler(() => trigger);

		expect(await (await handler(new Request("https://example.test/alias"))).text()).toBe("alias");
	});

	it("returns a streaming response unchanged", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: hello\\n\\n"));
				controller.close();
			},
		});
		const { trigger } = triggerFor(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
		const handler = createVercelHandler({ createTrigger: () => trigger });

		const response = await handler(new Request("https://example.test/events"));

		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toContain("data: hello");
	});
});
