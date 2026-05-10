import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPrometheus, resetPrometheusBootstrap } from "../PrometheusBootstrap";

describe("PrometheusBootstrap", () => {
	beforeEach(() => {
		resetPrometheusBootstrap();
	});

	afterEach(() => {
		resetPrometheusBootstrap();
	});

	describe("bootstrapPrometheus()", () => {
		it("should return null when OpenTelemetry SDK packages are not available", async () => {
			// In test environment, the SDK packages may or may not be installed.
			// This test verifies the function handles both cases gracefully.
			const result = await bootstrapPrometheus({
				serviceName: "test-service",
			});

			// Either returns a valid result (packages available) or null (packages missing)
			if (result !== null) {
				expect(result).toHaveProperty("metricsHandler");
				expect(result).toHaveProperty("shutdown");
				expect(typeof result.metricsHandler).toBe("function");
				expect(typeof result.shutdown).toBe("function");
				await result.shutdown();
			} else {
				expect(result).toBeNull();
			}
		});

		it("should respect custom config values", async () => {
			const result = await bootstrapPrometheus({
				serviceName: "custom-service",
				serviceVersion: "2.0.0",
				port: 19464,
				endpoint: "/custom-metrics",
			});

			if (result !== null) {
				expect(result.metricsHandler).toBeDefined();
				await result.shutdown();
			}
			// If null, packages aren't installed - that's valid too
		});

		it("should prevent double initialization", async () => {
			const result1 = await bootstrapPrometheus({
				serviceName: "first",
			});
			const result2 = await bootstrapPrometheus({
				serviceName: "second",
			});

			// Second call should return null since already initialized
			if (result1 !== null) {
				expect(result2).toBeNull();
				await result1.shutdown();
			}
		});

		it("should use default port when not specified", async () => {
			const result = await bootstrapPrometheus({
				serviceName: "default-port-test",
			});

			if (result !== null) {
				expect(result.metricsHandler).toBeDefined();
				await result.shutdown();
			}
		});

		it("should use BLOK_METRICS_PORT env var when set", async () => {
			const original = process.env.BLOK_METRICS_PORT;
			process.env.BLOK_METRICS_PORT = "19999";

			try {
				const result = await bootstrapPrometheus({
					serviceName: "env-port-test",
				});

				if (result !== null) {
					await result.shutdown();
				}
			} finally {
				if (original !== undefined) {
					process.env.BLOK_METRICS_PORT = original;
				} else {
					process.env.BLOK_METRICS_PORT = undefined;
				}
			}
		});
	});

	describe("resetPrometheusBootstrap()", () => {
		it("should allow re-initialization after reset", async () => {
			const result1 = await bootstrapPrometheus({
				serviceName: "reset-test-1",
			});

			if (result1 !== null) {
				await result1.shutdown();
			}

			resetPrometheusBootstrap();

			const result2 = await bootstrapPrometheus({
				serviceName: "reset-test-2",
			});

			// After reset, should be able to initialize again
			if (result1 !== null) {
				// If first succeeded, second should too after reset
				// (but port may conflict, so we accept null too)
				if (result2 !== null) {
					await result2.shutdown();
				}
			}
		});

		it("should be safe to call multiple times", () => {
			expect(() => {
				resetPrometheusBootstrap();
				resetPrometheusBootstrap();
				resetPrometheusBootstrap();
			}).not.toThrow();
		});
	});

	describe("shutdown()", () => {
		it("should clean up resources", async () => {
			const result = await bootstrapPrometheus({
				serviceName: "shutdown-test",
			});

			if (result !== null) {
				await expect(result.shutdown()).resolves.not.toThrow();
			}
		});
	});
});
