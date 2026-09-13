/**
 * #1016 — Bun-host proof for the shared multipart parser.
 *
 * The vitest suite (`__tests__/unit/httpRequestBody.test.ts`) covers the same
 * ground under Node. The parser touches `Request.body`, `File`, `node:fs`
 * handles and `Readable.toWeb`, all of which Bun implements separately, so the
 * claim "works on both hosts" needs an actual Bun run:
 *
 *     bun run --cwd core/shared test:bun
 *
 * Plain asserts, no test framework: `bun test` and vitest would both try to
 * own the file, and this is a smoke, not a suite.
 */

import { existsSync } from "node:fs";
import { parseHttpRequest } from "../../src/utils/httpRequestBody";
import { SpooledFile, UploadTooLargeError } from "../../src/utils/multipart";

let failures = 0;
const check = (label: string, ok: boolean): void => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

// Multipart parsing + `_method` spoofing + an in-memory (small) file part.
{
	const form = new FormData();
	form.set("_method", "put");
	form.set("name", "ada");
	form.set("avatar", new File([new TextEncoder().encode("hello")], "a.png", { type: "image/png" }));
	const parsed = await parseHttpRequest(new Request("http://localhost/u", { method: "POST", body: form }));
	const body = parsed.body as Record<string, unknown>;
	check("effective method is PUT", parsed.method === "PUT");
	check("originalMethod is POST", parsed.originalMethod === "POST");
	check("_method stripped from body", !("_method" in body));
	check("text field parsed", body.name === "ada");
	check("file part is a File", body.avatar instanceof File);
	check("file bytes intact", (await (body.avatar as File).text()) === "hello");
	await parsed.cleanup();
}

// Bracket keys (the Inertia client's wire shape) expand into structure.
{
	const form = new FormData();
	form.set("user[name]", "ada");
	form.set("tags[0]", "x");
	form.set("tags[1]", "y");
	form.set("docs[0]", new File(["1"], "one.txt"));
	form.set("docs[1]", new File(["2"], "two.txt"));
	form.set("__proto__", "nope");
	const parsed = await parseHttpRequest(new Request("http://localhost/u", { method: "POST", body: form }));
	const body = parsed.body as { user?: { name?: string }; tags?: unknown; docs?: unknown[] };
	check("nested object from user[name]", body.user?.name === "ada");
	check("array from tags[0]/tags[1]", JSON.stringify(body.tags) === '["x","y"]');
	check("file array from docs[0]/docs[1]", (parsed.files.docs as File[] | undefined)?.length === 2);
	check("prototype key dropped", !Object.hasOwn(body as Record<string, unknown>, "__proto__"));
	await parsed.cleanup();
}

// Spooling past the threshold, and cleanup.
{
	process.env.BLOK_UPLOAD_SPOOL_BYTES = "1024";
	const form = new FormData();
	form.set("big", new File([new Uint8Array(8192).fill(3)], "big.bin"));
	const parsed = await parseHttpRequest(new Request("http://localhost/u", { method: "POST", body: form }));
	const file = (parsed.body as Record<string, unknown>).big as SpooledFile;
	check("large part spooled to disk", file instanceof SpooledFile && existsSync(file.path));
	check("spooled size reported", file.size === 8192);
	check("spooled bytes readable", (await file.bytes()).length === 8192);
	await parsed.cleanup();
	check("temp file removed by cleanup", !existsSync(file.path));
	// biome-ignore lint/performance/noDelete: env reset must reach `undefined`.
	delete process.env.BLOK_UPLOAD_SPOOL_BYTES;
}

// The size cap (what the trigger turns into a 413).
{
	process.env.BLOK_MAX_UPLOAD_BYTES = "2048";
	const form = new FormData();
	form.set("big", new File([new Uint8Array(16384)], "big.bin"));
	let threw = false;
	try {
		await parseHttpRequest(new Request("http://localhost/u", { method: "POST", body: form }));
	} catch (err) {
		threw = err instanceof UploadTooLargeError;
	}
	check("over-cap upload throws UploadTooLargeError", threw);
	// biome-ignore lint/performance/noDelete: env reset must reach `undefined`.
	delete process.env.BLOK_MAX_UPLOAD_BYTES;
}

console.log(failures === 0 ? "bun multipart smoke PASSED" : `bun multipart smoke FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
