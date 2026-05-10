import { afterEach, describe, expect, it, vi } from "vitest";
import type {} from "../../hmr/FileWatcher";
import { HotReloadManager } from "../../hmr/HotReloadManager";

describe("HotReloadManager", () => {
	let manager: HotReloadManager;

	afterEach(async () => {
		if (manager) {
			await manager.stop();
		}
	});

	it("should initialize with default config", () => {
		manager = new HotReloadManager();
		const stats = manager.getStats();
		expect(stats.totalReloads).toBe(0);
		expect(stats.nodeReloads).toBe(0);
		expect(stats.workflowReloads).toBe(0);
		expect(stats.triggerReloads).toBe(0);
		expect(stats.errors).toBe(0);
		expect(stats.lastReload).toBeNull();
		expect(stats.lastError).toBeNull();
	});

	it("should not start in production mode", async () => {
		manager = new HotReloadManager({ enabled: false });

		const logSpy = vi.fn();
		manager.on("log", logSpy);

		await manager.start();

		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));
	});

	it("should register node change handlers", () => {
		manager = new HotReloadManager({ enabled: false });

		const handler = vi.fn();
		manager.onNodeChange(handler);

		// Handler should be registered (we can't easily trigger it without file system)
		expect(handler).not.toHaveBeenCalled();
	});

	it("should register workflow change handlers", () => {
		manager = new HotReloadManager({ enabled: false });

		const handler = vi.fn();
		manager.onWorkflowChange(handler);

		expect(handler).not.toHaveBeenCalled();
	});

	it("should register trigger change handlers", () => {
		manager = new HotReloadManager({ enabled: false });

		const handler = vi.fn();
		manager.onTriggerChange(handler);

		expect(handler).not.toHaveBeenCalled();
	});

	it("should track stats correctly", () => {
		manager = new HotReloadManager();
		const stats = manager.getStats();

		expect(stats.uptime).toBeGreaterThanOrEqual(0);
		expect(stats.totalReloads).toBe(0);
	});

	it("should invalidate module from cache", () => {
		manager = new HotReloadManager();

		// This should not throw even for non-existent modules
		const result = manager.invalidateModule("/nonexistent/module.ts");
		expect(result).toBe(false);
	});

	it("should invalidate modules matching pattern", () => {
		manager = new HotReloadManager();

		const count = manager.invalidateModules(/blok-test-nonexistent/);
		expect(count).toBe(0);
	});

	it("should invalidate modules matching string pattern", () => {
		manager = new HotReloadManager();

		const count = manager.invalidateModules("nonexistent-pattern");
		expect(count).toBe(0);
	});

	it("should return uptime in stats", async () => {
		manager = new HotReloadManager({ enabled: false });

		await new Promise((r) => setTimeout(r, 50));

		const stats = manager.getStats();
		expect(stats.uptime).toBeGreaterThanOrEqual(40);
	});

	it("should return cache-busted path from invalidateEsmModule", () => {
		manager = new HotReloadManager();

		const before = Date.now();
		const result = manager.invalidateEsmModule("/path/to/module.ts");
		const after = Date.now();

		expect(result).toMatch(/^\/path\/to\/module\.ts\?t=\d+$/);

		// Extract the timestamp and verify it's reasonable
		const timestamp = Number.parseInt(result.split("?t=")[1], 10);
		expect(timestamp).toBeGreaterThanOrEqual(before);
		expect(timestamp).toBeLessThanOrEqual(after);
	});

	it("should produce unique cache-busted paths on successive calls", async () => {
		manager = new HotReloadManager();

		const result1 = manager.invalidateEsmModule("/path/to/module.ts");
		await new Promise((r) => setTimeout(r, 5));
		const result2 = manager.invalidateEsmModule("/path/to/module.ts");

		// Timestamps should differ
		expect(result1).not.toBe(result2);
	});
});
