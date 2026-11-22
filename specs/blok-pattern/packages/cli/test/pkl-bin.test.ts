// Getting Pkl onto a machine that does not have it. Nothing here touches the internet:
// a local server stands in for the release page.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { check, locate } from "../src/index.ts";
import { PKL_VERSION, findPkl } from "../src/pkl-bin.ts";
import { cleanUp, folder, project, write } from "./helpers.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fake = '#!/bin/sh\necho "Pkl from the test server"\n';

let requests: string[] = [];
const files = new Map<string, Blob | string>([["pkl-test", fake]]);
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const name = new URL(request.url).pathname.slice(1);
		requests.push(name);
		const body = files.get(name);
		return body === undefined ? new Response("no such file", { status: 404 }) : new Response(body);
	},
});
const baseUrl = `http://localhost:${server.port}`;
afterAll(() => {
	server.stop(true);
	cleanUp();
});

/** A machine with no Pkl anywhere, whose release page is the local server. */
const bare = (cacheDir: string, sha256 = sha(fake), file = "pkl-test") => ({
	env: { PATH: "" },
	target: "test-machine",
	release: { "test-machine": { file, sha256 } },
	baseUrl,
	cacheDir,
});

test("a Pkl that is already there is used: BLOK_PKL first, then the PATH", async () => {
	const dir = folder();
	write(dir, "bin/pkl", fake);
	write(dir, "mine/pkl-custom", fake);
	requests = [];
	expect(await findPkl({ env: { PATH: `/nowhere:${join(dir, "bin")}` } })).toBe(join(dir, "bin", "pkl"));
	const custom = join(dir, "mine", "pkl-custom");
	expect(await findPkl({ env: { BLOK_PKL: custom, PATH: join(dir, "bin") } })).toBe(custom);
	expect(findPkl({ env: { BLOK_PKL: join(dir, "gone") } })).rejects.toThrow("which does not exist");
	expect(requests).toEqual([]);
});

test("a missing Pkl is downloaded once, checked against its checksum, and kept", async () => {
	const cache = folder();
	requests = [];
	const urls: string[] = [];
	const path = await findPkl({ ...bare(cache), onDownload: (url) => urls.push(url) });
	expect(path).toBe(join(cache, "pkl", PKL_VERSION, "pkl-test"));
	expect(urls).toEqual([`${baseUrl}/pkl-test`]);
	// It is the file that was served, it can be run, and nothing half-written is left beside it.
	expect(readFileSync(path, "utf8")).toBe(fake);
	expect(statSync(path).mode & 0o111).toBe(0o111);
	expect(spawnSync(path, ["--version"], { encoding: "utf8" }).stdout).toBe("Pkl from the test server\n");
	expect(readdirSync(join(cache, "pkl", PKL_VERSION))).toEqual(["pkl-test"]);

	// The second time there is nothing to fetch, even with downloads forbidden.
	expect(await findPkl({ ...bare(cache), env: { PATH: "", BLOK_OFFLINE: "1" } })).toBe(path);
	expect(requests).toEqual(["pkl-test"]);
});

test("a download that is not the expected file is thrown away and never run", async () => {
	const cache = folder();
	const wrong = "0".repeat(64);
	const refused = await findPkl(bare(cache, wrong)).catch((err: Error) => err.message);
	expect(refused).toBe(
		`The Pkl download from ${baseUrl}/pkl-test is not the file that was expected, so it was thrown away. Its SHA-256 is ${sha(fake)}, and it should be ${wrong}.`,
	);
	expect(existsSync(join(cache, "pkl"))).toBe(false);
});

test("when Pkl cannot be fetched, the message says what to do instead", async () => {
	const cache = folder();
	requests = [];
	expect(await findPkl(bare(cache, sha(fake), "pkl-gone")).catch((err: Error) => err.message)).toBe(
		`Workflows are written in Pkl, and it could not be downloaded from ${baseUrl}/pkl-gone: the server answered 404. Install Pkl yourself and put it on the PATH, or point BLOK_PKL at it.`,
	);
	// Intel Macs have no ready-made binary in this release. That is said plainly, before any request.
	requests = [];
	expect(
		await findPkl({ env: { PATH: "" }, target: "darwin-x64", cacheDir: cache }).catch((err: Error) => err.message),
	).toBe(
		`Workflows are written in Pkl, and Pkl ${PKL_VERSION} has no ready-made binary for darwin-x64. Install Pkl yourself (https://pkl-lang.org) and put it on the PATH, or point BLOK_PKL at it.`,
	);
	expect(
		await findPkl({ ...bare(cache), env: { PATH: "", BLOK_OFFLINE: "1" } }).catch((err: Error) => err.message),
	).toStartWith(
		"Workflows are written in Pkl, and no `pkl` command was found. BLOK_OFFLINE is set, so it was not downloaded.",
	);
	expect(requests).toEqual([]);
});

test("check on a machine without Pkl fetches it and then works, with the real Pkl served locally", async () => {
	// The real binary from this machine, served by the local server as the release page would serve it.
	const real = spawnSync("which", ["pkl"], { encoding: "utf8" }).stdout.trim();
	if (!real) throw new Error("This test needs a pkl command on this machine to serve.");
	const bytes = readFileSync(real);
	files.set("pkl-real", Bun.file(real));

	const dir = project();
	const cache = folder();
	requests = [];
	const pkl = bare(cache, sha(bytes), "pkl-real");
	const first = await check(locate(dir), { pkl });
	expect(first).toMatchObject({ ok: true, text: "1 node and 1 workflow line up." });
	expect(requests).toEqual(["pkl-real"]);
	expect(sha(readFileSync(join(cache, "pkl", PKL_VERSION, "pkl-real")))).toBe(sha(bytes));

	const second = await check(locate(dir), { pkl });
	expect(second.ok).toBe(true);
	expect(requests).toEqual(["pkl-real"]);
}, 30_000);
