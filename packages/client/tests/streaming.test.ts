import type { TypedWorkflow } from "@blokjs/helper";
import { describe, expect, it, vi } from "vitest";
import { createBlokClient } from "../src/index";

/** A streaming workflow's declared event union (TypedWorkflow's 3rd param). */
type JobEvent =
	| { type: "progress"; data: { pct: number } }
	| { type: "log"; data: { line: string } }
	| { type: "done"; data: { ok: boolean } };

type StreamApp = {
	jobs: { watch: TypedWorkflow<{ jobId: string }, unknown, JobEvent> };
};

/** Build a 200 text/event-stream Response whose body emits `chunks` in order. */
function sseResponse(chunks: string[], status = 200): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
	return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

describe("@blokjs/client — streaming via .stream() (P3.1)", () => {
	it("POSTs with Accept: text/event-stream and yields the typed event union", async () => {
		let seenUrl = "";
		let seenAccept = "";
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			seenUrl = String(url);
			seenAccept = (init?.headers as Record<string, string>).accept;
			return sseResponse([
				'event: progress\ndata: {"pct":10}\n\n',
				'event: progress\ndata: {"pct":100}\n\n',
				'event: done\ndata: {"ok":true}\n\n',
			]);
		}) as unknown as typeof fetch;
		const blok = createBlokClient<StreamApp>({ baseUrl: "https://api.test", fetch: fetchMock });

		const got: JobEvent[] = [];
		for await (const ev of blok.jobs.watch.stream({ jobId: "j1" })) got.push(ev);

		expect(seenUrl).toBe("https://api.test/__blok/rpc/jobs.watch");
		expect(seenAccept).toBe("text/event-stream");
		expect(got).toEqual([
			{ type: "progress", data: { pct: 10 } },
			{ type: "progress", data: { pct: 100 } },
			{ type: "done", data: { ok: true } },
		]);
	});

	it("reassembles frames split arbitrarily across network chunks", async () => {
		// One frame's bytes arrive in 3 separate reads; another spans a boundary.
		const fetchMock = vi.fn(async () =>
			sseResponse(["event: prog", 'ress\ndata: {"pct":', "42}\n\nevent: done\nda", 'ta: {"ok":true}\n\n']),
		) as unknown as typeof fetch;
		const blok = createBlokClient<StreamApp>({ fetch: fetchMock });

		const got: JobEvent[] = [];
		for await (const ev of blok.jobs.watch.stream({ jobId: "j" })) got.push(ev);
		expect(got).toEqual([
			{ type: "progress", data: { pct: 42 } },
			{ type: "done", data: { ok: true } },
		]);
	});

	it("skips `:` keep-alive comments and joins multi-line data", async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([": keep-alive\n\n", "event: log\ndata: line one\ndata: line two\n\n"]),
		) as unknown as typeof fetch;
		const blok = createBlokClient<StreamApp>({ fetch: fetchMock });

		const got: JobEvent[] = [];
		for await (const ev of blok.jobs.watch.stream({ jobId: "j" })) got.push(ev);
		// data is non-JSON here → surfaced verbatim (joined with \n), never dropped.
		expect(got).toEqual([{ type: "log", data: "line one\nline two" }]);
	});

	it("flushes a trailing frame with no final blank line", async () => {
		const fetchMock = vi.fn(async () => sseResponse(['event: done\ndata: {"ok":true}'])) as unknown as typeof fetch;
		const blok = createBlokClient<StreamApp>({ fetch: fetchMock });
		const got: JobEvent[] = [];
		for await (const ev of blok.jobs.watch.stream({ jobId: "j" })) got.push(ev);
		expect(got).toEqual([{ type: "done", data: { ok: true } }]);
	});

	it("throws BlokClientError on a non-2xx stream response", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "nope" }), {
					status: 403,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const blok = createBlokClient<StreamApp>({ fetch: fetchMock });

		await expect(async () => {
			for await (const _ of blok.jobs.watch.stream({ jobId: "j" })) {
				/* should throw before yielding */
			}
		}).rejects.toMatchObject({ name: "BlokClientError", status: 403, body: { error: "nope" } });
	});
});
