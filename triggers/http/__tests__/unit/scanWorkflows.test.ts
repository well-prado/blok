import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveUrlFromFilePath, scanWorkflows } from "../../src/runner/scanWorkflows";

describe("deriveUrlFromFilePath", () => {
	it("flat file → /<name>", () => {
		expect(deriveUrlFromFilePath("health.ts")).toBe("/health");
	});

	it("nested file → /<dir>/<name>", () => {
		expect(deriveUrlFromFilePath(path.join("users", "list.ts"))).toBe("/users/list");
	});

	it("index.ts at root → /", () => {
		expect(deriveUrlFromFilePath("index.ts")).toBe("/");
	});

	it("index.ts in subfolder → /<folder>", () => {
		expect(deriveUrlFromFilePath(path.join("users", "index.ts"))).toBe("/users");
	});

	it("[id].ts → :id param", () => {
		expect(deriveUrlFromFilePath(path.join("users", "[id].ts"))).toBe("/users/:id");
	});

	it("nested [param] segments", () => {
		expect(deriveUrlFromFilePath(path.join("users", "[id]", "orders.ts"))).toBe("/users/:id/orders");
	});

	it("multiple [param] segments", () => {
		expect(deriveUrlFromFilePath(path.join("users", "[uid]", "orders", "[oid].ts"))).toBe("/users/:uid/orders/:oid");
	});

	it("strips file extensions case-insensitively", () => {
		expect(deriveUrlFromFilePath("foo.TS")).toBe("/foo");
		expect(deriveUrlFromFilePath("foo.json")).toBe("/foo");
		expect(deriveUrlFromFilePath("foo.JSON")).toBe("/foo");
	});

	it("strips leading segments per stripLeadingSegments", () => {
		expect(deriveUrlFromFilePath(path.join("json", "users", "list.json"), 1)).toBe("/users/list");
	});

	it("strips leading segments while honouring index", () => {
		expect(deriveUrlFromFilePath(path.join("json", "users", "index.json"), 1)).toBe("/users");
	});
});

describe("scanWorkflows — disk integration", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-scan-"));
	});

	afterEach(async () => {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	});

	it("scans nested JSON workflows under a single root", async () => {
		const root = path.join(tmpDir, "json");
		await fsp.mkdir(path.join(root, "users"), { recursive: true });
		await fsp.writeFile(
			path.join(root, "health.json"),
			JSON.stringify({ name: "Health", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		await fsp.writeFile(
			path.join(root, "users", "list.json"),
			JSON.stringify({ name: "List Users", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		await fsp.writeFile(
			path.join(root, "users", "[id].json"),
			JSON.stringify({ name: "Get User", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);

		const out = await scanWorkflows([{ dir: root, kind: "json" }]);
		const paths = out.map((w) => w.defaultPath).sort();
		expect(paths).toEqual(["/health", "/users/:id", "/users/list"]);
	});

	it("respects stripLeadingSegments when the format folder is part of the root path", async () => {
		// Mirror the production layout where workflows/json/ is a single
		// scan root but the `json` folder name shouldn't appear in URLs.
		const root = tmpDir;
		await fsp.mkdir(path.join(root, "json", "users"), { recursive: true });
		await fsp.writeFile(
			path.join(root, "json", "users", "list.json"),
			JSON.stringify({ name: "List", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		const out = await scanWorkflows([{ dir: root, kind: "json", stripLeadingSegments: 1 }]);
		expect(out).toHaveLength(1);
		expect(out[0].defaultPath).toBe("/users/list");
	});

	it("skips files starting with _ or .", async () => {
		const root = tmpDir;
		await fsp.writeFile(
			path.join(root, "_helper.json"),
			JSON.stringify({ name: "Helper", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		await fsp.writeFile(
			path.join(root, ".draft.json"),
			JSON.stringify({ name: "Draft", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		await fsp.writeFile(
			path.join(root, "real.json"),
			JSON.stringify({ name: "Real", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		const out = await scanWorkflows([{ dir: root, kind: "json" }]);
		expect(out.map((w) => w.name)).toEqual(["Real"]);
	});

	it("skips dirs starting with _ or .", async () => {
		const root = tmpDir;
		await fsp.mkdir(path.join(root, "_helpers"), { recursive: true });
		await fsp.mkdir(path.join(root, ".drafts"), { recursive: true });
		await fsp.mkdir(path.join(root, "users"), { recursive: true });
		await fsp.writeFile(
			path.join(root, "_helpers", "x.json"),
			JSON.stringify({ name: "Hidden", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		await fsp.writeFile(
			path.join(root, "users", "list.json"),
			JSON.stringify({ name: "List", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		const out = await scanWorkflows([{ dir: root, kind: "json" }]);
		expect(out.map((w) => w.name)).toEqual(["List"]);
	});

	it("returns empty when the root doesn't exist (no error)", async () => {
		const out = await scanWorkflows([{ dir: path.join(tmpDir, "nope"), kind: "json" }]);
		expect(out).toEqual([]);
	});

	it("calls onLoadError for invalid JSON without throwing", async () => {
		const root = tmpDir;
		await fsp.writeFile(path.join(root, "bad.json"), "{ not valid");
		await fsp.writeFile(
			path.join(root, "good.json"),
			JSON.stringify({ name: "Good", version: "1.0.0", trigger: { http: { method: "GET" } } }),
		);
		const errors: string[] = [];
		const out = await scanWorkflows([{ dir: root, kind: "json" }], {
			onLoadError: (file) => errors.push(file),
		});
		expect(out).toHaveLength(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("bad.json");
	});
});
