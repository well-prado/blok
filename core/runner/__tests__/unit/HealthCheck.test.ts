import { beforeEach, describe, expect, it } from "vitest";
import { HealthCheck } from "../../src/monitoring/HealthCheck";
import type {} from "../../src/monitoring/HealthCheck";

describe("HealthCheck", () => {
	let healthCheck: HealthCheck;

	beforeEach(() => {
		healthCheck = new HealthCheck(1000);
	});

	describe("liveness", () => {
		it("should return ok status with uptime", () => {
			const result = healthCheck.liveness();
			expect(result.status).toBe("ok");
			expect(result.uptime).toBeGreaterThanOrEqual(0);
		});
	});

	describe("check", () => {
		it("should return healthy when no dependencies are registered", async () => {
			const result = await healthCheck.check();
			expect(result.status).toBe("healthy");
			expect(result.timestamp).toBeGreaterThan(0);
			expect(result.uptime).toBeGreaterThanOrEqual(0);
			expect(Object.keys(result.checks)).toHaveLength(0);
		});

		it("should return healthy when all dependencies are healthy", async () => {
			healthCheck.registerDependency("db", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));
			healthCheck.registerDependency("cache", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));

			const result = await healthCheck.check();
			expect(result.status).toBe("healthy");
			expect(result.checks.db.status).toBe("healthy");
			expect(result.checks.cache.status).toBe("healthy");
		});

		it("should return degraded when any dependency is degraded", async () => {
			healthCheck.registerDependency("db", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));
			healthCheck.registerDependency("cache", async () => ({
				status: "degraded",
				message: "High latency",
				lastChecked: Date.now(),
			}));

			const result = await healthCheck.check();
			expect(result.status).toBe("degraded");
		});

		it("should return unhealthy when any dependency is unhealthy", async () => {
			healthCheck.registerDependency("db", async () => ({
				status: "unhealthy",
				message: "Connection refused",
				lastChecked: Date.now(),
			}));
			healthCheck.registerDependency("cache", async () => ({
				status: "healthy",
				lastChecked: Date.now(),
			}));

			const result = await healthCheck.check();
			expect(result.status).toBe("unhealthy");
		});

		it("should catch errors from check functions and mark as unhealthy", async () => {
			healthCheck.registerDependency("failing", async () => {
				throw new Error("Connection timeout");
			});

			const result = await healthCheck.check();
			expect(result.status).toBe("unhealthy");
			expect(result.checks.failing.status).toBe("unhealthy");
			expect(result.checks.failing.message).toBe("Connection timeout");
		});

		it("should record latency for each check", async () => {
			healthCheck.registerDependency("slow", async () => {
				await new Promise((r) => setTimeout(r, 10));
				return { status: "healthy", lastChecked: Date.now() };
			});

			const result = await healthCheck.check();
			expect(result.checks.slow.latency_ms).toBeGreaterThan(0);
		});

		it("should cache results within the cache window", async () => {
			let callCount = 0;
			healthCheck.registerDependency("counted", async () => {
				callCount++;
				return { status: "healthy", lastChecked: Date.now() };
			});

			await healthCheck.check();
			await healthCheck.check();

			expect(callCount).toBe(1);
		});

		it("should refresh cache after expiry", async () => {
			const hc = new HealthCheck(50); // 50ms cache
			let callCount = 0;
			hc.registerDependency("counted", async () => {
				callCount++;
				return { status: "healthy", lastChecked: Date.now() };
			});

			await hc.check();
			await new Promise((r) => setTimeout(r, 60));
			await hc.check();

			expect(callCount).toBe(2);
		});
	});

	describe("readiness", () => {
		it("should return ready when healthy", async () => {
			const result = await healthCheck.readiness();
			expect(result.ready).toBe(true);
			expect(result.status).toBe("healthy");
		});

		it("should return ready when degraded", async () => {
			healthCheck.registerDependency("cache", async () => ({
				status: "degraded",
				lastChecked: Date.now(),
			}));

			const result = await healthCheck.readiness();
			expect(result.ready).toBe(true);
			expect(result.status).toBe("degraded");
		});

		it("should return not ready when unhealthy", async () => {
			healthCheck.registerDependency("db", async () => ({
				status: "unhealthy",
				lastChecked: Date.now(),
			}));

			const result = await healthCheck.readiness();
			expect(result.ready).toBe(false);
			expect(result.status).toBe("unhealthy");
		});
	});

	describe("dependency management", () => {
		it("should register and remove dependencies", async () => {
			healthCheck.registerDependency("temp", async () => ({
				status: "unhealthy",
				lastChecked: Date.now(),
			}));

			let result = await healthCheck.check();
			expect(result.status).toBe("unhealthy");

			healthCheck.removeDependency("temp");
			result = await healthCheck.check();
			expect(result.status).toBe("healthy");
		});
	});
});
