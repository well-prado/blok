import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldServerlessDeployment } from "../../../src/commands/create/project";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("serverless scaffold", () => {
	it("writes a fetch adapter entrypoint and API-first Vercel rewrites", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-serverless-"));
		dirs.push(dir);
		scaffoldServerlessDeployment(dir);

		expect(fs.readFileSync(path.join(dir, "api/index.ts"), "utf8")).toContain(
			'import handler from "../src/triggers/http/serverless.js"',
		);
		const config = JSON.parse(fs.readFileSync(path.join(dir, "vercel.json"), "utf8"));
		expect(config.functions["api/index.ts"].runtime).toBe("nodejs22.x");
		expect(config.rewrites[0]).toEqual({ source: "/api/:path*", destination: "/api/index" });
		expect(config.rewrites[1].destination).toBe("/api/index");
	});

	it("never overwrites user-owned deployment files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-serverless-"));
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, "api"));
		fs.writeFileSync(path.join(dir, "api/index.ts"), "user code\n");
		expect(() => scaffoldServerlessDeployment(dir)).toThrow(/overwrite existing file/);
		expect(fs.readFileSync(path.join(dir, "api/index.ts"), "utf8")).toBe("user code\n");
	});
});
