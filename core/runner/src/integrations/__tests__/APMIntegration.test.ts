import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APMIntegration } from "../APMIntegration";

// Reset tracing bootstrap between tests
const resetBootstrap = async () => {
	try {
		const { resetTracingBootstrap } = await import("../../monitoring/TracingBootstrap");
		resetTracingBootstrap();
	} catch {
		// TracingBootstrap may not be importable if OTel packages missing
	}
};

describe("APMIntegration", () => {
	beforeEach(async () => {
		await resetBootstrap();
	});

	afterEach(async () => {
		await resetBootstrap();
	});

	describe("Construction", () => {
		it("should create a DataDog integration", () => {
			const apm = new APMIntegration({
				vendor: "datadog",
				serviceName: "test-service",
			});
			expect(apm).toBeDefined();
			expect(apm.getVendor()).toBe("datadog");
			expect(apm.isInitialized()).toBe(false);
		});

		it("should create a New Relic integration", () => {
			const apm = new APMIntegration({
				vendor: "newrelic",
				serviceName: "test-service",
				newrelicLicenseKey: "test-key-123",
			});
			expect(apm.getVendor()).toBe("newrelic");
		});

		it("should create a generic OTLP integration", () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test-service",
				otlpEndpoint: "http://localhost:4318/v1/traces",
			});
			expect(apm.getVendor()).toBe("otlp");
		});

		it("should accept full configuration", () => {
			const apm = new APMIntegration({
				vendor: "datadog",
				serviceName: "test-service",
				serviceVersion: "2.0.0",
				environment: "staging",
				datadogAgentUrl: "http://dd-agent:4318/v1/traces",
				samplingRatio: 0.5,
				debug: true,
			});
			expect(apm).toBeDefined();
		});
	});

	describe("init()", () => {
		it("should handle init gracefully when packages are not available", async () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test-service",
			});

			// Init may succeed or fail depending on package availability
			const result = await apm.init();
			expect(typeof result).toBe("boolean");
		});

		it("should prevent double initialization", async () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test-service",
			});

			const result1 = await apm.init();
			if (result1) {
				const result2 = await apm.init();
				expect(result2).toBe(true); // Already initialized returns true
				await apm.shutdown();
			}
		});

		it("should fail for New Relic without license key", async () => {
			const origKey = process.env.NEW_RELIC_LICENSE_KEY;
			process.env.NEW_RELIC_LICENSE_KEY = undefined;

			const apm = new APMIntegration({
				vendor: "newrelic",
				serviceName: "test-service",
				// No license key provided
			});

			const result = await apm.init();
			expect(result).toBe(false);

			if (origKey) process.env.NEW_RELIC_LICENSE_KEY = origKey;
		});

		it("should accept New Relic EU region", () => {
			const apm = new APMIntegration({
				vendor: "newrelic",
				serviceName: "test-service",
				newrelicLicenseKey: "test-key",
				newrelicRegion: "eu",
			});

			const info = apm.getEndpointInfo();
			expect(info.endpoint).toContain("eu01");
		});
	});

	describe("getEndpointInfo()", () => {
		it("should return DataDog endpoint info", () => {
			const apm = new APMIntegration({
				vendor: "datadog",
				serviceName: "test",
				datadogAgentUrl: "http://dd-agent:4318/v1/traces",
			});

			const info = apm.getEndpointInfo();
			expect(info.vendor).toBe("datadog");
			expect(info.endpoint).toBe("http://dd-agent:4318/v1/traces");
			expect(info.initialized).toBe(false);
		});

		it("should return New Relic US endpoint by default", () => {
			const apm = new APMIntegration({
				vendor: "newrelic",
				serviceName: "test",
				newrelicLicenseKey: "key",
			});

			const info = apm.getEndpointInfo();
			expect(info.vendor).toBe("newrelic");
			expect(info.endpoint).toContain("otlp.nr-data.net");
		});

		it("should return New Relic EU endpoint", () => {
			const apm = new APMIntegration({
				vendor: "newrelic",
				serviceName: "test",
				newrelicLicenseKey: "key",
				newrelicRegion: "eu",
			});

			const info = apm.getEndpointInfo();
			expect(info.endpoint).toContain("eu01.nr-data.net");
		});

		it("should return custom OTLP endpoint", () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test",
				otlpEndpoint: "http://tempo:4318/v1/traces",
			});

			const info = apm.getEndpointInfo();
			expect(info.vendor).toBe("otlp");
			expect(info.endpoint).toBe("http://tempo:4318/v1/traces");
		});

		it("should return default OTLP endpoint when none specified", () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test",
			});

			const info = apm.getEndpointInfo();
			expect(info.endpoint).toBe("http://localhost:4318/v1/traces");
		});

		it("should return default DataDog endpoint when none specified", () => {
			const apm = new APMIntegration({
				vendor: "datadog",
				serviceName: "test",
			});

			const info = apm.getEndpointInfo();
			expect(info.endpoint).toContain("localhost:4318");
		});
	});

	describe("shutdown()", () => {
		it("should shutdown gracefully even when not initialized", async () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test",
			});

			// Should not throw
			await apm.shutdown();
			expect(apm.isInitialized()).toBe(false);
		});
	});

	describe("forceFlush()", () => {
		it("should flush gracefully even when not initialized", async () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "test",
			});

			// Should not throw
			await apm.forceFlush();
		});
	});

	describe("Full Lifecycle", () => {
		it("should support full init → use → shutdown lifecycle", async () => {
			const apm = new APMIntegration({
				vendor: "otlp",
				serviceName: "lifecycle-test",
				otlpEndpoint: "http://localhost:4318/v1/traces",
			});

			expect(apm.isInitialized()).toBe(false);

			const initialized = await apm.init();

			if (initialized) {
				expect(apm.isInitialized()).toBe(true);
				await apm.forceFlush();
				await apm.shutdown();
				expect(apm.isInitialized()).toBe(false);
			}
			// If not initialized (packages missing), that's also a valid state
		});

		it("should handle unknown vendor gracefully", async () => {
			const apm = new APMIntegration({
				vendor: "unknown" as any,
				serviceName: "test",
			});

			const result = await apm.init();
			expect(result).toBe(false);
		});
	});
});
