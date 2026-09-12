import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSwiftIfChanged, swiftSourcesDigest } from "../../src/services/runtime-setup.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function sdk(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-swift-sdk-"));
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, "Sources", "BlokSwiftRuntime"), { recursive: true });
	fs.writeFileSync(path.join(dir, "Package.swift"), "// package");
	fs.writeFileSync(path.join(dir, "Sources", "BlokSwiftRuntime", "Node.swift"), "public enum A {}");
	return dir;
}

describe("buildSwiftIfChanged", () => {
	it("builds when no binary exists, then skips while sources are unchanged", async () => {
		const dir = sdk();
		const build = vi.fn(async () => {
			fs.mkdirSync(path.join(dir, ".build", "release"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".build", "release", "blok-swift-runtime"), "bin");
		});
		expect(await buildSwiftIfChanged(dir, build)).toBe(true);
		expect(await buildSwiftIfChanged(dir, build)).toBe(false);
		expect(build).toHaveBeenCalledTimes(1);
	});

	it("rebuilds when a generated or user source changes", async () => {
		const dir = sdk();
		const build = vi.fn(async () => {
			fs.mkdirSync(path.join(dir, ".build", "release"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".build", "release", "blok-swift-runtime"), "bin");
		});
		await buildSwiftIfChanged(dir, build);
		const before = swiftSourcesDigest(dir);
		fs.writeFileSync(path.join(dir, "Sources", "BlokSwiftRuntime", "GeneratedUserNodeRegistry.swift"), "// gen");
		expect(swiftSourcesDigest(dir)).not.toBe(before);
		expect(await buildSwiftIfChanged(dir, build)).toBe(true);
		expect(build).toHaveBeenCalledTimes(2);
	});
});
