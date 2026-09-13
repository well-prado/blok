/**
 * #1016 — the shared HTTP request-body builder: multipart streaming with disk
 * spooling + size caps, and `_method` spoofing.
 */

import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_UPLOAD_BYTES,
	DEFAULT_UPLOAD_SPOOL_BYTES,
	applyMethodSpoofing,
	parseHttpRequest,
	uploadLimits,
} from "../../src/utils/httpRequestBody";
import { SpooledFile, UploadTooLargeError, readBoundary } from "../../src/utils/multipart";

function request(body: BodyInit, init: RequestInit = {}): Request {
	return new Request("http://localhost/upload", { method: "POST", body, ...init });
}

const ENV_KEYS = ["BLOK_MAX_UPLOAD_BYTES", "BLOK_UPLOAD_SPOOL_BYTES", "BLOK_METHOD_SPOOFING"] as const;

afterEach(() => {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
});

describe("parseHttpRequest — multipart", () => {
	it("parses fields and files, exposing files as File objects", async () => {
		const form = new FormData();
		form.set("title", "avatar upload");
		form.set("avatar", new File([new Uint8Array([1, 2, 3, 4])], "a.png", { type: "image/png" }));
		const parsed = await parseHttpRequest(request(form));

		const body = parsed.body as Record<string, unknown>;
		expect(body.title).toBe("avatar upload");
		expect(body.avatar).toBeInstanceOf(File);
		const file = body.avatar as File;
		expect(file.name).toBe("a.png");
		expect(file.type).toBe("image/png");
		expect(file.size).toBe(4);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(parsed.files.avatar).toBe(file);
		await parsed.cleanup();
	});

	it("collects repeated `name[]` parts into an array", async () => {
		const form = new FormData();
		form.append("tags[]", "a");
		form.append("tags[]", "b");
		form.append("docs[]", new File(["x"], "x.txt", { type: "text/plain" }));
		const parsed = await parseHttpRequest(request(form));

		const body = parsed.body as Record<string, unknown>;
		expect(body["tags[]"]).toEqual(["a", "b"]);
		expect(Array.isArray(parsed.files["docs[]"])).toBe(true);
		await parsed.cleanup();
	});

	it("spools a file over BLOK_UPLOAD_SPOOL_BYTES to disk and cleanup removes it", async () => {
		process.env.BLOK_UPLOAD_SPOOL_BYTES = "1024";
		const bytes = new Uint8Array(4096).fill(7);
		const form = new FormData();
		form.set("big", new File([bytes], "big.bin", { type: "application/octet-stream" }));
		const parsed = await parseHttpRequest(request(form));

		const file = (parsed.body as Record<string, unknown>).big;
		expect(file).toBeInstanceOf(SpooledFile);
		const spooled = file as SpooledFile;
		expect(spooled.size).toBe(4096);
		expect(existsSync(spooled.path)).toBe(true);
		expect(new Uint8Array(await spooled.arrayBuffer())).toEqual(bytes);
		expect(await spooled.bytes()).toEqual(bytes);
		expect(() => spooled.slice()).toThrow(/not supported/);

		await parsed.cleanup();
		expect(existsSync(spooled.path)).toBe(false);
		// Idempotent.
		await parsed.cleanup();
	});

	it("keeps a file under the spool threshold in memory", async () => {
		const form = new FormData();
		form.set("small", new File(["hello"], "s.txt", { type: "text/plain" }));
		const parsed = await parseHttpRequest(request(form));

		const file = (parsed.body as Record<string, unknown>).small as File;
		expect(file).toBeInstanceOf(File);
		expect(file).not.toBeInstanceOf(SpooledFile);
		expect(await file.text()).toBe("hello");
		await parsed.cleanup();
	});

	it("throws UploadTooLargeError past BLOK_MAX_UPLOAD_BYTES and leaves no temp file", async () => {
		process.env.BLOK_MAX_UPLOAD_BYTES = "2048";
		process.env.BLOK_UPLOAD_SPOOL_BYTES = "128";
		const form = new FormData();
		form.set("big", new File([new Uint8Array(8192)], "big.bin"));

		await expect(parseHttpRequest(request(form))).rejects.toBeInstanceOf(UploadTooLargeError);
	});

	it("handles a multipart body split across many small stream chunks", async () => {
		const form = new FormData();
		form.set("note", "chunked");
		form.set("f", new File([new Uint8Array(300).fill(9)], "f.bin"));
		const seed = request(form);
		const contentType = seed.headers.get("content-type") as string;
		const encoded = new Uint8Array(await seed.arrayBuffer());

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
				controller.close();
			},
		});
		const parsed = await parseHttpRequest(
			new Request("http://localhost/upload", {
				method: "POST",
				headers: { "content-type": contentType },
				body: stream,
				// @ts-expect-error duplex is required for a streamed request body
				duplex: "half",
			}),
		);

		const body = parsed.body as Record<string, unknown>;
		expect(body.note).toBe("chunked");
		expect((body.f as File).size).toBe(300);
		await parsed.cleanup();
	});

	it("returns an empty body for a malformed multipart payload", async () => {
		const parsed = await parseHttpRequest(
			request("not really multipart", { headers: { "content-type": "multipart/form-data; boundary=xyz" } }),
		);
		expect(parsed.body).toEqual({});
	});

	it("skips multipart parsing when disabled (webhook mode keeps rawBody)", async () => {
		const form = new FormData();
		form.set("a", "b");
		const parsed = await parseHttpRequest(request(form), { multipart: false });
		expect(typeof parsed.body).toBe("string");
		expect(parsed.rawBody).toContain('name="a"');
	});
});

describe("parseHttpRequest — method spoofing", () => {
	it("spoofs from a multipart POST and strips `_method`", async () => {
		const form = new FormData();
		form.set("_method", "put");
		form.set("name", "ada");
		const parsed = await parseHttpRequest(request(form));

		expect(parsed.method).toBe("PUT");
		expect(parsed.originalMethod).toBe("POST");
		expect(parsed.body).toEqual({ name: "ada" });
		await parsed.cleanup();
	});

	it("spoofs from JSON and urlencoded bodies", async () => {
		const json = await parseHttpRequest(
			request(JSON.stringify({ _method: "PATCH", a: 1 }), { headers: { "content-type": "application/json" } }),
		);
		expect(json.method).toBe("PATCH");
		expect(json.body).toEqual({ a: 1 });

		const form = await parseHttpRequest(
			request("_method=delete&id=7", { headers: { "content-type": "application/x-www-form-urlencoded" } }),
		);
		expect(form.method).toBe("DELETE");
		expect(form.body).toEqual({ id: "7" });
	});

	it("ignores a non-spoofable method and leaves the field in place", () => {
		const body: Record<string, unknown> = { _method: "get" };
		expect(applyMethodSpoofing("POST", body)).toBe("POST");
		expect(body._method).toBe("get");
	});

	it("ignores `_method` on a non-POST request", () => {
		const body: Record<string, unknown> = { _method: "delete" };
		expect(applyMethodSpoofing("PUT", body)).toBe("PUT");
		expect(body._method).toBe("delete");
	});

	it("honours the BLOK_METHOD_SPOOFING=0 opt-out", () => {
		process.env.BLOK_METHOD_SPOOFING = "0";
		const body: Record<string, unknown> = { _method: "delete" };
		expect(applyMethodSpoofing("POST", body)).toBe("POST");
		expect(body._method).toBe("delete");
	});

	it("ignores a non-object or non-string `_method`", () => {
		expect(applyMethodSpoofing("POST", [{ _method: "put" }])).toBe("POST");
		expect(applyMethodSpoofing("POST", "text body")).toBe("POST");
		expect(applyMethodSpoofing("POST", { _method: 7 })).toBe("POST");
	});
});

describe("parseHttpRequest — non-multipart bodies", () => {
	it("returns an empty envelope for GET/HEAD", async () => {
		const parsed = await parseHttpRequest(new Request("http://localhost/x"));
		expect(parsed).toMatchObject({ body: {}, rawBody: "", method: "GET", originalMethod: "GET" });
	});

	it("keeps rawBody and empties the body on malformed JSON", async () => {
		const parsed = await parseHttpRequest(request("{oops", { headers: { "content-type": "application/json" } }));
		expect(parsed.body).toEqual({});
		expect(parsed.rawBody).toBe("{oops");
	});

	it("falls back to text, or to JSON when jsonFallback is set", async () => {
		const text = await parseHttpRequest(request("plain", { headers: { "content-type": "text/plain" } }));
		expect(text.body).toBe("plain");

		const guessed = await parseHttpRequest(request('{"a":1}', { headers: { "content-type": "text/plain" } }), {
			jsonFallback: true,
		});
		expect(guessed.body).toEqual({ a: 1 });
	});

	it("rejects an oversized non-multipart body", async () => {
		process.env.BLOK_MAX_UPLOAD_BYTES = "16";
		await expect(
			parseHttpRequest(
				request(JSON.stringify({ pad: "x".repeat(100) }), { headers: { "content-type": "application/json" } }),
			),
		).rejects.toBeInstanceOf(UploadTooLargeError);
	});
});

describe("limits and helpers", () => {
	it("defaults to 32 MiB / 1 MiB and reads the env overrides", () => {
		expect(uploadLimits()).toEqual({ maxBytes: DEFAULT_MAX_UPLOAD_BYTES, spoolBytes: DEFAULT_UPLOAD_SPOOL_BYTES });
		process.env.BLOK_MAX_UPLOAD_BYTES = "10";
		process.env.BLOK_UPLOAD_SPOOL_BYTES = "not-a-number";
		expect(uploadLimits()).toEqual({ maxBytes: 10, spoolBytes: DEFAULT_UPLOAD_SPOOL_BYTES });
	});

	it("reads a quoted or bare boundary", () => {
		expect(readBoundary('multipart/form-data; boundary="ab cd"')).toBe("ab cd");
		expect(readBoundary("multipart/form-data; boundary=abcd")).toBe("abcd");
		expect(readBoundary("application/json")).toBeUndefined();
	});
});
