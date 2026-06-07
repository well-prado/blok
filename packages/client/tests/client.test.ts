import type { TypedWorkflow } from "@blokjs/helper";
import { describe, expect, it, vi } from "vitest";
import { type BlokClient, BlokClientError, createBlokClient } from "../src/index";

/** A representative generated `BlokApp` type (what `blokctl gen app-types` emits). */
type App = {
	users: {
		list: TypedWorkflow<{ q?: string }, { users: string[]; total: number }>;
		create: TypedWorkflow<{ name: string }, { id: string }>;
	};
	health: TypedWorkflow<Record<string, never>, { ok: boolean }>;
};

/** Build a fetch mock that returns `body` as JSON with `status`. */
function jsonFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void) {
	return vi.fn(async (url: string | URL, init?: RequestInit) => {
		capture?.(String(url), init ?? {});
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

describe("createBlokClient — unary (P1.4)", () => {
	it("POSTs to /__blok/rpc/<dotted-name> with the input as the JSON body and returns parsed output", async () => {
		let seenUrl = "";
		let seenInit: RequestInit = {};
		const fetchMock = jsonFetch(200, { users: ["ada"], total: 1 }, (u, i) => {
			seenUrl = u;
			seenInit = i;
		});
		const blok = createBlokClient<App>({ baseUrl: "https://api.test", fetch: fetchMock });

		const out = await blok.users.list({ q: "ada" });

		expect(seenUrl).toBe("https://api.test/__blok/rpc/users.list");
		expect(seenInit.method).toBe("POST");
		expect(JSON.parse(seenInit.body as string)).toEqual({ q: "ada" });
		expect(out).toEqual({ users: ["ada"], total: 1 });
	});

	it("trims a trailing slash from baseUrl and supports same-origin ('' base)", async () => {
		let seenUrl = "";
		const fetchMock = jsonFetch(200, { ok: true }, (u) => {
			seenUrl = u;
		});
		const blok = createBlokClient<App>({ baseUrl: "https://api.test/", fetch: fetchMock });
		await blok.health({});
		expect(seenUrl).toBe("https://api.test/__blok/rpc/health");

		let relUrl = "";
		const relClient = createBlokClient<App>({
			fetch: jsonFetch(200, { ok: true }, (u) => {
				relUrl = u;
			}),
		});
		await relClient.health({});
		expect(relUrl).toBe("/__blok/rpc/health");
	});

	it("sends headers from the (async) headers() factory on every call", async () => {
		const headers: Record<string, string>[] = [];
		const fetchMock = vi.fn(async (_u: string | URL, init?: RequestInit) => {
			headers.push(init?.headers as Record<string, string>);
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		let token = "t1";
		const blok = createBlokClient<App>({
			fetch: fetchMock,
			headers: async () => ({ Authorization: `Bearer ${token}` }),
		});

		await blok.users.create({ name: "ada" });
		token = "t2";
		await blok.users.create({ name: "bob" });

		expect(headers[0].Authorization).toBe("Bearer t1");
		expect(headers[1].Authorization).toBe("Bearer t2");
		// content-type is always set; the factory merges over the defaults.
		expect(headers[0]["content-type"]).toBe("application/json");
	});

	it("throws BlokClientError with status + parsed body on a non-2xx response", async () => {
		const fetchMock = jsonFetch(422, { error: "invalid" });
		const blok = createBlokClient<App>({ fetch: fetchMock });

		await expect(blok.users.create({ name: "" })).rejects.toMatchObject({
			name: "BlokClientError",
			status: 422,
			workflow: "users.create",
			body: { error: "invalid" },
		});
		expect(new BlokClientError(404, null, "x")).toBeInstanceOf(Error);
	});

	it("resolves nested group paths into dotted names (a.b.c)", async () => {
		type Deep = { a: { b: { c: TypedWorkflow<{ n: number }, { doubled: number }> } } };
		let seenUrl = "";
		const fetchMock = jsonFetch(200, { doubled: 4 }, (u) => {
			seenUrl = u;
		});
		const blok = createBlokClient<Deep>({ baseUrl: "http://x", fetch: fetchMock });
		const out = await blok.a.b.c({ n: 2 });
		expect(seenUrl).toBe("http://x/__blok/rpc/a.b.c");
		expect(out).toEqual({ doubled: 4 });
	});

	it("does not pretend to be a thenable (awaiting a group node does not hang)", async () => {
		const blok = createBlokClient<App>({ fetch: jsonFetch(200, {}) });
		// `then` resolves to undefined on the proxy → not a thenable → this awaits
		// the proxy object itself, not an infinite chain.
		const usersGroup = blok.users as unknown as { then?: unknown };
		expect(usersGroup.then).toBeUndefined();
	});

	it("infers the typed return (compile-time intent)", async () => {
		const blok: BlokClient<App> = createBlokClient<App>({ fetch: jsonFetch(200, { users: [], total: 0 }) });
		const out = await blok.users.list({ q: "x" });
		// `out` is typed { users: string[]; total: number }
		const total: number = out.total;
		const first: string | undefined = out.users[0];
		expect(total).toBe(0);
		expect(first).toBeUndefined();
	});
});
