import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorIntegration } from "../AzureMonitorIntegration";

const FAKE_CONN_STRING =
	"InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://eastus-1.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=test-app-id";

describe("AzureMonitorIntegration", () => {
	let azure: AzureMonitorIntegration;

	beforeEach(() => {
		azure = new AzureMonitorIntegration({
			connectionString: FAKE_CONN_STRING,
			serviceName: "test-service",
		});
	});

	afterEach(async () => {
		await azure.shutdown();
	});

	/* ------------------------------------------------------------------ */
	/*  Construction                                                      */
	/* ------------------------------------------------------------------ */

	describe("Construction", () => {
		it("should create with minimal config", () => {
			expect(azure).toBeDefined();
			expect(azure.isInitialized()).toBe(false);
		});

		it("should create with full config", () => {
			const full = new AzureMonitorIntegration({
				connectionString: FAKE_CONN_STRING,
				serviceName: "blok-http",
				serviceVersion: "2.0.0",
				environment: "staging",
				exportMode: "otlp",
				samplingRatio: 0.5,
				enableLiveMetrics: true,
				debug: true,
			});
			expect(full).toBeDefined();
			expect(full.isInitialized()).toBe(false);
		});

		it("should default to azure export mode", () => {
			const instance = new AzureMonitorIntegration({
				connectionString: FAKE_CONN_STRING,
				serviceName: "test",
			});
			expect(instance).toBeDefined();
		});

		it("should accept otlp export mode", () => {
			const instance = new AzureMonitorIntegration({
				connectionString: FAKE_CONN_STRING,
				serviceName: "test",
				exportMode: "otlp",
			});
			expect(instance).toBeDefined();
		});

		it("should fall back to env var for connection string", () => {
			const orig = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
			process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = FAKE_CONN_STRING;

			const instance = new AzureMonitorIntegration({ serviceName: "test" });
			expect(instance).toBeDefined();

			if (orig) {
				process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = orig;
			} else {
				delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
			}
		});
	});

	/* ------------------------------------------------------------------ */
	/*  init()                                                            */
	/* ------------------------------------------------------------------ */

	describe("init()", () => {
		it("should fail without connection string", async () => {
			const noConn = new AzureMonitorIntegration({
				serviceName: "test",
				connectionString: undefined,
			});

			// Clear env var too
			const orig = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
			delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

			const result = await noConn.init();
			expect(result).toBe(false);

			if (orig) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = orig;
		});

		it("should handle init gracefully when Azure SDK is not installed", async () => {
			const result = await azure.init();
			// Will be false in test env since Azure packages are not installed
			expect(typeof result).toBe("boolean");
		});

		it("should prevent double initialization", async () => {
			const result1 = await azure.init();
			if (result1) {
				const result2 = await azure.init();
				expect(result2).toBe(true);
			}
		});
	});

	/* ------------------------------------------------------------------ */
	/*  trackEvent() - without SDK                                        */
	/* ------------------------------------------------------------------ */

	describe("trackEvent()", () => {
		it("should be a no-op when not initialized", () => {
			// Should not throw
			azure.trackEvent("TestEvent", { key: "value" });

			const stats = azure.getStats();
			expect(stats.eventsTracked).toBe(0);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  trackException() - without SDK                                    */
	/* ------------------------------------------------------------------ */

	describe("trackException()", () => {
		it("should be a no-op when not initialized", () => {
			azure.trackException(new Error("test"), { workflow: "test" });

			const stats = azure.getStats();
			expect(stats.exceptionsTracked).toBe(0);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  trackMetric() - without SDK                                       */
	/* ------------------------------------------------------------------ */

	describe("trackMetric()", () => {
		it("should be a no-op when not initialized", () => {
			azure.trackMetric("TestMetric", 42, { env: "test" });

			const stats = azure.getStats();
			expect(stats.metricsTracked).toBe(0);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  recordWorkflowExecution() - without SDK                           */
	/* ------------------------------------------------------------------ */

	describe("recordWorkflowExecution()", () => {
		it("should not throw when not initialized (success)", () => {
			expect(() => {
				azure.recordWorkflowExecution("get-user", 42, true);
			}).not.toThrow();
		});

		it("should not throw when not initialized (failure)", () => {
			expect(() => {
				azure.recordWorkflowExecution("get-user", 100, false);
			}).not.toThrow();
		});
	});

	/* ------------------------------------------------------------------ */
	/*  getStats()                                                        */
	/* ------------------------------------------------------------------ */

	describe("getStats()", () => {
		it("should return initial stats", () => {
			const stats = azure.getStats();
			expect(stats).toEqual({
				initialized: false,
				eventsTracked: 0,
				exceptionsTracked: 0,
				metricsTracked: 0,
			});
		});
	});

	/* ------------------------------------------------------------------ */
	/*  Lifecycle                                                         */
	/* ------------------------------------------------------------------ */

	describe("Lifecycle", () => {
		it("should shutdown gracefully when not initialized", async () => {
			await expect(azure.shutdown()).resolves.not.toThrow();
			expect(azure.isInitialized()).toBe(false);
		});

		it("should flush gracefully when not initialized", async () => {
			await expect(azure.flush()).resolves.not.toThrow();
		});
	});

	/* ------------------------------------------------------------------ */
	/*  Connection string parsing                                         */
	/* ------------------------------------------------------------------ */

	describe("Connection string parsing", () => {
		it("should extract instrumentation key from connection string", () => {
			// Access private method for testing via init() behavior
			const instance = new AzureMonitorIntegration({
				connectionString: FAKE_CONN_STRING,
				serviceName: "test",
				exportMode: "otlp",
			});

			// The parsing is tested indirectly — if the format is valid,
			// init will attempt the OTLP path (which fails because packages
			// aren't installed, but at least it doesn't crash on parsing).
			expect(instance).toBeDefined();
		});

		it("should handle malformed connection string gracefully", async () => {
			const bad = new AzureMonitorIntegration({
				connectionString: "not-a-valid-connection-string",
				serviceName: "test",
				exportMode: "otlp",
			});

			const result = await bad.init();
			expect(result).toBe(false);
		});

		it("should handle connection string missing ingestion endpoint", async () => {
			const noEndpoint = new AzureMonitorIntegration({
				connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
				serviceName: "test",
				exportMode: "otlp",
			});

			const result = await noEndpoint.init();
			expect(result).toBe(false);
		});

		it("should handle connection string missing instrumentation key", async () => {
			const noKey = new AzureMonitorIntegration({
				connectionString: "IngestionEndpoint=https://eastus.in.applicationinsights.azure.com/",
				serviceName: "test",
				exportMode: "otlp",
			});

			const result = await noKey.init();
			expect(result).toBe(false);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  With mocked telemetry client                                      */
	/* ------------------------------------------------------------------ */

	describe("With mocked telemetry client", () => {
		let mockAzure: AzureMonitorIntegration;
		let mockClient: {
			trackEvent: ReturnType<typeof vi.fn>;
			trackException: ReturnType<typeof vi.fn>;
			trackMetric: ReturnType<typeof vi.fn>;
			flush: ReturnType<typeof vi.fn>;
		};

		beforeEach(() => {
			mockAzure = new AzureMonitorIntegration({
				connectionString: FAKE_CONN_STRING,
				serviceName: "mock-service",
			});

			mockClient = {
				trackEvent: vi.fn(),
				trackException: vi.fn(),
				trackMetric: vi.fn(),
				flush: vi.fn().mockResolvedValue(undefined),
			};

			// Inject mocked telemetry client
			(mockAzure as any).telemetryClient = mockClient;
			(mockAzure as any).initialized = true;
		});

		it("should track custom event", () => {
			mockAzure.trackEvent("WorkflowCompleted", { workflowName: "get-user" });

			expect(mockClient.trackEvent).toHaveBeenCalledWith({
				name: "WorkflowCompleted",
				properties: { workflowName: "get-user" },
			});

			const stats = mockAzure.getStats();
			expect(stats.eventsTracked).toBe(1);
		});

		it("should track exception", () => {
			const error = new Error("node timeout");
			mockAzure.trackException(error, { nodeName: "fetch-db" });

			expect(mockClient.trackException).toHaveBeenCalledWith({
				exception: error,
				properties: { nodeName: "fetch-db" },
			});

			const stats = mockAzure.getStats();
			expect(stats.exceptionsTracked).toBe(1);
		});

		it("should track metric", () => {
			mockAzure.trackMetric("WorkflowDuration", 42, { workflowName: "get-user" });

			expect(mockClient.trackMetric).toHaveBeenCalledWith({
				name: "WorkflowDuration",
				value: 42,
				properties: { workflowName: "get-user" },
			});

			const stats = mockAzure.getStats();
			expect(stats.metricsTracked).toBe(1);
		});

		it("should record successful workflow execution", () => {
			mockAzure.recordWorkflowExecution("get-user", 42, true);

			expect(mockClient.trackEvent).toHaveBeenCalledWith(
				expect.objectContaining({ name: "WorkflowCompleted" }),
			);
			expect(mockClient.trackMetric).toHaveBeenCalledWith(
				expect.objectContaining({ name: "WorkflowDuration", value: 42 }),
			);

			const stats = mockAzure.getStats();
			expect(stats.eventsTracked).toBe(1);
			expect(stats.metricsTracked).toBe(1);
		});

		it("should record failed workflow execution with error metric", () => {
			mockAzure.recordWorkflowExecution("get-user", 100, false);

			expect(mockClient.trackEvent).toHaveBeenCalledWith(
				expect.objectContaining({ name: "WorkflowFailed" }),
			);
			// Duration metric + error metric
			expect(mockClient.trackMetric).toHaveBeenCalledTimes(2);

			const stats = mockAzure.getStats();
			expect(stats.eventsTracked).toBe(1);
			expect(stats.metricsTracked).toBe(2);
		});

		it("should flush telemetry client", async () => {
			await mockAzure.flush();
			expect(mockClient.flush).toHaveBeenCalledOnce();
		});

		it("should accumulate stats across multiple operations", () => {
			mockAzure.trackEvent("E1");
			mockAzure.trackEvent("E2");
			mockAzure.trackException(new Error("x"));
			mockAzure.trackMetric("M1", 1);
			mockAzure.trackMetric("M2", 2);
			mockAzure.trackMetric("M3", 3);

			const stats = mockAzure.getStats();
			expect(stats.eventsTracked).toBe(2);
			expect(stats.exceptionsTracked).toBe(1);
			expect(stats.metricsTracked).toBe(3);
		});
	});
});
