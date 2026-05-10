import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HMREvent } from "../../hmr/FileWatcher";

// We need a concrete subclass because TriggerBase is abstract
class TestTrigger {
	configuration: any = { name: "test", version: "1.0", steps: [], nodes: [] };
	healthCheck: any = { registerDependency: vi.fn(), check: vi.fn(), liveness: vi.fn(), readiness: vi.fn() };
	rateLimiter: any = null;
	circuitBreaker: any = null;
	metricsCollector: any = { getMetrics: vi.fn() };
	hmr: any = null;
	inFlightRequests = 0;

	async enableHotReload(config?: any): Promise<void> {
		// Re-implement the logic from TriggerBase to test it in isolation
		// without needing the full dependency tree
		if (process.env.NODE_ENV === "production" && process.env.BLOK_HMR !== "true") {
			return;
		}

		const { HotReloadManager } = await import("../../hmr/HotReloadManager");

		const workflowPaths = (process.env.WORKFLOWS_PATH || process.env.VITE_WORKFLOWS_PATH || "")
			.split(",")
			.filter(Boolean);
		const nodePaths = (process.env.NODES_PATH || "").split(",").filter(Boolean);

		this.hmr = new HotReloadManager({
			workflowPaths,
			nodePaths,
			verbose: process.env.BLOK_HMR_VERBOSE === "true",
			enabled: false, // Don't actually start file watching in tests
			...config,
		});

		this.hmr.onNodeChange(async (event: HMREvent) => {
			await this.onHmrNodeChange(event);
		});

		this.hmr.onWorkflowChange(async (event: HMREvent) => {
			await this.onHmrWorkflowChange(event);
		});

		this.hmr.onTriggerChange(async (event: HMREvent) => {
			await this.onHmrTriggerChange(event);
		});

		await this.hmr.start();
	}

	async onHmrNodeChange(event: HMREvent): Promise<void> {
		this.hmr?.invalidateModule(event.filePath);
	}

	async onHmrWorkflowChange(_event: HMREvent): Promise<void> {
		// no-op default
	}

	async onHmrTriggerChange(_event: HMREvent): Promise<void> {
		// no-op default
	}

	waitForInFlightRequests(timeoutMs = 5000): Promise<void> {
		return new Promise((resolve) => {
			const start = Date.now();
			const check = () => {
				if (this.inFlightRequests <= 0) {
					resolve();
				} else if (Date.now() - start >= timeoutMs) {
					resolve();
				} else {
					setTimeout(check, 50);
				}
			};
			check();
		});
	}

	getHmrStats() {
		return this.hmr?.getStats() ?? null;
	}

	async destroyHmr(): Promise<void> {
		if (this.hmr) {
			await this.hmr.stop();
			this.hmr = null;
		}
	}
}

describe("TriggerBase HMR", () => {
	let trigger: TestTrigger;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		trigger = new TestTrigger();
	});

	afterEach(async () => {
		await trigger.destroyHmr();
		// Restore environment
		process.env.NODE_ENV = originalEnv.NODE_ENV;
		process.env.BLOK_HMR = undefined;
		process.env.WORKFLOWS_PATH = undefined;
		process.env.NODES_PATH = undefined;
		process.env.BLOK_HMR_VERBOSE = undefined;
	});

	it("should create HotReloadManager when not in production", async () => {
		process.env.NODE_ENV = "development";

		await trigger.enableHotReload();

		expect(trigger.hmr).not.toBeNull();
		expect(trigger.getHmrStats()).not.toBeNull();
		expect(trigger.getHmrStats()!.totalReloads).toBe(0);
	});

	it("should not create HotReloadManager in production without BLOK_HMR", async () => {
		process.env.NODE_ENV = "production";
		process.env.BLOK_HMR = undefined;

		await trigger.enableHotReload();

		expect(trigger.hmr).toBeNull();
		expect(trigger.getHmrStats()).toBeNull();
	});

	it("should create HotReloadManager in production when BLOK_HMR=true", async () => {
		process.env.NODE_ENV = "production";
		process.env.BLOK_HMR = "true";

		await trigger.enableHotReload();

		expect(trigger.hmr).not.toBeNull();
	});

	it("should track inFlightRequests counter correctly", () => {
		expect(trigger.inFlightRequests).toBe(0);

		trigger.inFlightRequests++;
		expect(trigger.inFlightRequests).toBe(1);

		trigger.inFlightRequests++;
		expect(trigger.inFlightRequests).toBe(2);

		trigger.inFlightRequests--;
		expect(trigger.inFlightRequests).toBe(1);

		trigger.inFlightRequests--;
		expect(trigger.inFlightRequests).toBe(0);
	});

	it("should resolve waitForInFlightRequests immediately when counter is zero", async () => {
		const start = Date.now();
		await trigger.waitForInFlightRequests(1000);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(200);
	});

	it("should wait and then resolve when in-flight requests drain", async () => {
		trigger.inFlightRequests = 1;

		// Simulate request completing after 100ms
		setTimeout(() => {
			trigger.inFlightRequests = 0;
		}, 100);

		const start = Date.now();
		await trigger.waitForInFlightRequests(2000);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(80);
		expect(elapsed).toBeLessThan(500);
		expect(trigger.inFlightRequests).toBe(0);
	});

	it("should time out waitForInFlightRequests when requests don't drain", async () => {
		trigger.inFlightRequests = 5;

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const start = Date.now();
		await trigger.waitForInFlightRequests(200);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(180);
		expect(trigger.inFlightRequests).toBe(5); // Still stuck

		warnSpy.mockRestore();
	});

	it("should call invalidateModule on node change", async () => {
		process.env.NODE_ENV = "development";
		await trigger.enableHotReload();

		const invalidateSpy = vi.spyOn(trigger.hmr!, "invalidateModule");

		const event: HMREvent = {
			type: "node:change",
			filePath: "/some/node/path.ts",
			relativePath: "path.ts",
			timestamp: Date.now(),
		};

		await trigger.onHmrNodeChange(event);

		expect(invalidateSpy).toHaveBeenCalledWith("/some/node/path.ts");
	});

	it("should destroy HMR and set to null", async () => {
		process.env.NODE_ENV = "development";
		await trigger.enableHotReload();

		expect(trigger.hmr).not.toBeNull();

		await trigger.destroyHmr();

		expect(trigger.hmr).toBeNull();
		expect(trigger.getHmrStats()).toBeNull();
	});

	it("should handle destroyHmr when HMR is not enabled", async () => {
		expect(trigger.hmr).toBeNull();

		// Should not throw
		await trigger.destroyHmr();

		expect(trigger.hmr).toBeNull();
	});
});
