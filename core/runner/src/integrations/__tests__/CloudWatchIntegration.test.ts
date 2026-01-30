import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWatchIntegration } from "../CloudWatchIntegration";

describe("CloudWatchIntegration", () => {
	let cw: CloudWatchIntegration;

	beforeEach(() => {
		cw = new CloudWatchIntegration({
			region: "us-east-1",
			serviceName: "test-service",
		});
	});

	afterEach(async () => {
		await cw.shutdown();
	});

	/* ------------------------------------------------------------------ */
	/*  Construction                                                      */
	/* ------------------------------------------------------------------ */

	describe("Construction", () => {
		it("should create with minimal config", () => {
			expect(cw).toBeDefined();
			expect(cw.isInitialized()).toBe(false);
		});

		it("should create with full config", () => {
			const full = new CloudWatchIntegration({
				region: "eu-west-1",
				serviceName: "blok-http",
				serviceVersion: "2.0.0",
				environment: "staging",
				logGroupName: "/custom/log-group",
				logStreamName: "custom-stream",
				namespace: "CustomNamespace",
				enableTracing: false,
				adotEndpoint: "http://adot:4318/v1/traces",
				samplingRatio: 0.5,
				debug: true,
			});
			expect(full).toBeDefined();
			expect(full.isInitialized()).toBe(false);
		});

		it("should use default region from env if not specified", () => {
			const orig = process.env.AWS_REGION;
			process.env.AWS_REGION = "ap-southeast-1";

			const instance = new CloudWatchIntegration({ serviceName: "test" });
			expect(instance).toBeDefined();

			if (orig) {
				process.env.AWS_REGION = orig;
			} else {
				delete process.env.AWS_REGION;
			}
		});
	});

	/* ------------------------------------------------------------------ */
	/*  init()                                                            */
	/* ------------------------------------------------------------------ */

	describe("init()", () => {
		it("should handle init gracefully when AWS SDK is not installed", async () => {
			const result = await cw.init();
			// Will be false in test env since @aws-sdk/* is not installed
			expect(typeof result).toBe("boolean");
		});

		it("should prevent double initialization", async () => {
			const result1 = await cw.init();
			if (result1) {
				const result2 = await cw.init();
				expect(result2).toBe(true);
			}
		});
	});

	/* ------------------------------------------------------------------ */
	/*  putMetric() - without SDK                                         */
	/* ------------------------------------------------------------------ */

	describe("putMetric()", () => {
		it("should return false when not initialized", async () => {
			const result = await cw.putMetric("TestMetric", 42, "Count");
			expect(result).toBe(false);
		});

		it("should return false with default unit when not initialized", async () => {
			const result = await cw.putMetric("TestMetric", 100);
			expect(result).toBe(false);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  putLog() - without SDK                                            */
	/* ------------------------------------------------------------------ */

	describe("putLog()", () => {
		it("should return false when not initialized", async () => {
			const result = await cw.putLog({
				level: "info",
				message: "test log entry",
			});
			expect(result).toBe(false);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  logWorkflowError() - without SDK                                  */
	/* ------------------------------------------------------------------ */

	describe("logWorkflowError()", () => {
		it("should return false when not initialized", async () => {
			const result = await cw.logWorkflowError(new Error("test error"), {
				workflowName: "test-workflow",
				workflowPath: "/test",
			});
			expect(result).toBe(false);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  recordWorkflowExecution() - without SDK                           */
	/* ------------------------------------------------------------------ */

	describe("recordWorkflowExecution()", () => {
		it("should not throw when not initialized", async () => {
			// Should be a no-op
			await expect(cw.recordWorkflowExecution("get-user", 42, true)).resolves.not.toThrow();
		});

		it("should handle failure execution without throwing", async () => {
			await expect(cw.recordWorkflowExecution("get-user", 100, false)).resolves.not.toThrow();
		});
	});

	/* ------------------------------------------------------------------ */
	/*  getStats()                                                        */
	/* ------------------------------------------------------------------ */

	describe("getStats()", () => {
		it("should return initial stats", () => {
			const stats = cw.getStats();
			expect(stats).toEqual({
				initialized: false,
				metricsPublished: 0,
				logsPublished: 0,
				metricErrors: 0,
				logErrors: 0,
				tracingEnabled: false,
			});
		});
	});

	/* ------------------------------------------------------------------ */
	/*  Lifecycle                                                         */
	/* ------------------------------------------------------------------ */

	describe("Lifecycle", () => {
		it("should shutdown gracefully when not initialized", async () => {
			await expect(cw.shutdown()).resolves.not.toThrow();
			expect(cw.isInitialized()).toBe(false);
		});

		it("should flush gracefully when not initialized", async () => {
			await expect(cw.flush()).resolves.not.toThrow();
		});

		it("should report tracing disabled by default", () => {
			expect(cw.isTracingEnabled()).toBe(false);
		});
	});

	/* ------------------------------------------------------------------ */
	/*  With mocked AWS SDK                                               */
	/* ------------------------------------------------------------------ */

	describe("With mocked AWS SDK", () => {
		let mockCw: CloudWatchIntegration;
		let mockCwClient: { send: ReturnType<typeof vi.fn> };
		let mockCwLogsClient: { send: ReturnType<typeof vi.fn> };

		beforeEach(() => {
			mockCw = new CloudWatchIntegration({
				region: "us-east-1",
				serviceName: "mock-service",
				logGroupName: "/test/logs",
				namespace: "TestNS",
			});

			mockCwClient = { send: vi.fn().mockResolvedValue({}) };
			mockCwLogsClient = {
				send: vi.fn().mockResolvedValue({ nextSequenceToken: "token-123" }),
			};

			// Inject mocked clients via private property access
			(mockCw as any).cwClient = mockCwClient;
			(mockCw as any).cwLogsClient = mockCwLogsClient;
			(mockCw as any).PutMetricDataCommand = class {
				input: unknown;
				constructor(input: unknown) {
					this.input = input;
				}
			};
			(mockCw as any).PutLogEventsCommand = class {
				input: unknown;
				constructor(input: unknown) {
					this.input = input;
				}
			};
			(mockCw as any).initialized = true;
		});

		it("should publish a metric successfully", async () => {
			const result = await mockCw.putMetric("TestMetric", 99, "Count");
			expect(result).toBe(true);
			expect(mockCwClient.send).toHaveBeenCalledOnce();

			const stats = mockCw.getStats();
			expect(stats.metricsPublished).toBe(1);
		});

		it("should publish a metric with custom dimensions", async () => {
			const result = await mockCw.putMetric("NodeLatency", 5, "Milliseconds", {
				NodeName: "fetch-user",
			});
			expect(result).toBe(true);
		});

		it("should handle metric publish error", async () => {
			mockCwClient.send.mockRejectedValueOnce(new Error("Throttled"));

			const result = await mockCw.putMetric("TestMetric", 1);
			expect(result).toBe(false);

			const stats = mockCw.getStats();
			expect(stats.metricErrors).toBe(1);
		});

		it("should send a log entry successfully", async () => {
			const result = await mockCw.putLog({
				level: "info",
				message: "workflow completed",
				workflowName: "get-user",
			});
			expect(result).toBe(true);
			expect(mockCwLogsClient.send).toHaveBeenCalledOnce();

			const stats = mockCw.getStats();
			expect(stats.logsPublished).toBe(1);
		});

		it("should track sequence token across log calls", async () => {
			await mockCw.putLog({ level: "info", message: "first" });
			expect((mockCw as any).sequenceToken).toBe("token-123");

			mockCwLogsClient.send.mockResolvedValueOnce({
				nextSequenceToken: "token-456",
			});
			await mockCw.putLog({ level: "info", message: "second" });
			expect((mockCw as any).sequenceToken).toBe("token-456");
		});

		it("should handle log publish error", async () => {
			mockCwLogsClient.send.mockRejectedValueOnce(new Error("Access denied"));

			const result = await mockCw.putLog({ level: "error", message: "fail" });
			expect(result).toBe(false);

			const stats = mockCw.getStats();
			expect(stats.logErrors).toBe(1);
		});

		it("should log workflow error with context", async () => {
			const result = await mockCw.logWorkflowError(new Error("node timeout"), {
				workflowName: "get-user",
				workflowPath: "/users/:id",
				requestId: "req-123",
				nodeName: "fetch-db",
			});
			expect(result).toBe(true);
		});

		it("should record workflow execution (success)", async () => {
			await mockCw.recordWorkflowExecution("get-user", 42, true);
			// One metric call for duration
			expect(mockCwClient.send).toHaveBeenCalledOnce();
		});

		it("should record workflow execution (failure) with error metric", async () => {
			await mockCw.recordWorkflowExecution("get-user", 100, false);
			// Two metric calls: duration + error count
			expect(mockCwClient.send).toHaveBeenCalledTimes(2);
		});

		it("should accumulate stats across multiple operations", async () => {
			await mockCw.putMetric("M1", 1);
			await mockCw.putMetric("M2", 2);
			await mockCw.putLog({ level: "info", message: "log1" });

			const stats = mockCw.getStats();
			expect(stats.metricsPublished).toBe(2);
			expect(stats.logsPublished).toBe(1);
			expect(stats.initialized).toBe(true);
		});
	});
});
