/**
 * LocalStorage — dotted-name tolerance (Bug 03, secondary defense-in-depth)
 *
 * The dot heuristic in `LocalStorage.get` previously treated ANY tail after
 * the last `.` as a file extension and threw `File type not supported` when
 * it wasn't json/yaml/xml/toml. That broke the framework's own recommended
 * dotted `domain.action` workflow-name convention on every disk-resolver path
 * (notably the worker trigger pre-fix).
 *
 * After the fix, a non-extension tail is treated as part of the NAME — the
 * lookup falls through to the in-memory `workflowLocator` fallback or the
 * accurate `Workflow not found` error. Genuine file extensions are still
 * stripped and read from `WORKFLOWS_PATH/<type>/`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import LocalStorage from "../LocalStorage";
import type { WorkflowLocator } from "../types/GlobalOptions";

/** Build a minimal locator entry honoring LocalStorage's `.toJson()` contract. */
function locatorEntry(config: Record<string, unknown>) {
	return { toJson: () => JSON.stringify(config) } as unknown as WorkflowLocator[string];
}

describe("LocalStorage.get — dotted names (Bug 03 secondary)", () => {
	let storage: LocalStorage;
	let tmpDir: string;
	const prevPath = process.env.WORKFLOWS_PATH;
	const prevVitePath = process.env.VITE_WORKFLOWS_PATH;

	beforeEach(() => {
		storage = new LocalStorage();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-localstorage-"));
		process.env.WORKFLOWS_PATH = tmpDir;
		// VITE_WORKFLOWS_PATH takes precedence in get() — clear it so the test
		// dir is honored (delete, NOT assign undefined — assigning coerces to
		// the literal string "undefined").
		// biome-ignore lint/performance/noDelete: env-var reset must reach `undefined`, not the string "undefined".
		delete process.env.VITE_WORKFLOWS_PATH;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		// biome-ignore lint/performance/noDelete: restore literal absence.
		if (prevPath === undefined) delete process.env.WORKFLOWS_PATH;
		else process.env.WORKFLOWS_PATH = prevPath;
		// biome-ignore lint/performance/noDelete: restore literal absence.
		if (prevVitePath === undefined) delete process.env.VITE_WORKFLOWS_PATH;
		else process.env.VITE_WORKFLOWS_PATH = prevVitePath;
	});

	it("resolves a dotted name from the in-memory locator without throwing 'File type not supported'", async () => {
		const config = { name: "publish.site", version: "1.0.0", steps: [{ id: "a", use: "echo" }] };
		const locator: WorkflowLocator = { "publish.site": locatorEntry(config) };

		const result = await storage.get("publish.site", locator);
		expect(result).toMatchObject({ name: "publish.site" });
	});

	it("throws the ACCURATE 'Workflow not found' (not the file-type error) when a dotted name is absent", async () => {
		await expect(storage.get("publish.site", {} as WorkflowLocator)).rejects.toThrow(
			"Workflow not found: publish.site",
		);
	});

	it("checks only the LAST segment for multi-dot names (order.line.item)", async () => {
		const config = { name: "order.line.item", version: "1.0.0", steps: [{ id: "a", use: "echo" }] };
		const locator: WorkflowLocator = { "order.line.item": locatorEntry(config) };

		// `item` is not a fileType, so the whole name is kept and the locator
		// fallback resolves it. No `File type not supported: item`.
		const result = await storage.get("order.line.item", locator);
		expect(result).toMatchObject({ name: "order.line.item" });
	});

	it("still parses a genuine .json extension and reads from WORKFLOWS_PATH/json/", async () => {
		const jsonDir = path.join(tmpDir, "json", "users");
		fs.mkdirSync(jsonDir, { recursive: true });
		const wf = { name: "list", version: "1.0.0", steps: [{ id: "a", use: "echo" }] };
		fs.writeFileSync(path.join(jsonDir, "list.json"), JSON.stringify(wf), "utf8");

		const result = await storage.get("users/list.json", {} as WorkflowLocator);
		expect(result).toMatchObject({ name: "list" });
	});

	it("still parses a genuine .yaml extension and reads from WORKFLOWS_PATH/yaml/", async () => {
		const yamlDir = path.join(tmpDir, "yaml", "users");
		fs.mkdirSync(yamlDir, { recursive: true });
		fs.writeFileSync(path.join(yamlDir, "list.yaml"), "name: list\nversion: 1.0.0\n", "utf8");

		const result = await storage.get("users/list.yaml", {} as WorkflowLocator);
		expect(result).toMatchObject({ name: "list" });
	});

	it("handles a real upstream dot before a genuine extension (a.b.json)", async () => {
		const jsonDir = path.join(tmpDir, "json");
		fs.mkdirSync(jsonDir, { recursive: true });
		const wf = { name: "a.b", version: "1.0.0", steps: [{ id: "x", use: "echo" }] };
		fs.writeFileSync(path.join(jsonDir, "a.b.json"), JSON.stringify(wf), "utf8");

		const result = await storage.get("a.b.json", {} as WorkflowLocator);
		expect(result).toMatchObject({ name: "a.b" });
	});
});
