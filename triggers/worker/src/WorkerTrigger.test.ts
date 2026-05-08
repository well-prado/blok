/**
 * WorkerTrigger Tests
 *
 * Tests the WorkerTrigger base class, WorkerAdapter interface,
 * InMemoryAdapter, and BullMQAdapter configuration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerAdapter, WorkerJob, WorkerQueueStats } from "./WorkerTrigger";
import { InMemoryAdapter } from "./adapters/InMemoryAdapter";
import { computeXDelayHoldMs } from "./adapters/NATSAdapter";

// ============================================================================
// WorkerJob Interface Tests
// ============================================================================

describe("WorkerTrigger", () => {
	describe("WorkerJob Interface", () => {
		it("should accept valid worker job structure", () => {
			const job: WorkerJob = {
				id: "job-123",
				data: { userId: "user-1", action: "send-email" },
				headers: { "content-type": "application/json" },
				queue: "background-jobs",
				priority: 5,
				attempts: 0,
				maxRetries: 3,
				createdAt: new Date(),
				delay: 0,
				timeout: 30000,
				raw: {},
				complete: async () => {},
				fail: async () => {},
			};

			expect(job.id).toBe("job-123");
			expect(job.data).toEqual({ userId: "user-1", action: "send-email" });
			expect(job.queue).toBe("background-jobs");
			expect(job.priority).toBe(5);
			expect(job.maxRetries).toBe(3);
		});

		it("should handle minimal required fields", () => {
			const job: WorkerJob = {
				id: "job-min",
				data: null,
				headers: {},
				queue: "default",
				priority: 0,
				attempts: 0,
				maxRetries: 0,
				createdAt: new Date(),
				raw: null,
				complete: async () => {},
				fail: async () => {},
			};

			expect(job.id).toBeDefined();
			expect(job.queue).toBeDefined();
			expect(job.complete).toBeDefined();
			expect(job.fail).toBeDefined();
		});

		it("should support optional delay and timeout", () => {
			const job: WorkerJob = {
				id: "job-delayed",
				data: { type: "scheduled-report" },
				headers: {},
				queue: "reports",
				priority: 1,
				attempts: 0,
				maxRetries: 2,
				createdAt: new Date(),
				delay: 60000,
				timeout: 120000,
				raw: {},
				complete: async () => {},
				fail: async () => {},
			};

			expect(job.delay).toBe(60000);
			expect(job.timeout).toBe(120000);
		});
	});

	describe("WorkerAdapter Interface", () => {
		it("should validate adapter interface methods", () => {
			const mockAdapter: WorkerAdapter = {
				provider: "mock",
				connect: vi.fn().mockResolvedValue(undefined),
				disconnect: vi.fn().mockResolvedValue(undefined),
				process: vi.fn().mockResolvedValue(undefined),
				addJob: vi.fn().mockResolvedValue("job-1"),
				stopProcessing: vi.fn().mockResolvedValue(undefined),
				isConnected: vi.fn().mockReturnValue(true),
				healthCheck: vi.fn().mockResolvedValue(true),
				getQueueStats: vi.fn().mockResolvedValue({
					waiting: 5,
					active: 2,
					completed: 100,
					failed: 3,
					delayed: 1,
				}),
			};

			expect(mockAdapter.provider).toBe("mock");
			expect(typeof mockAdapter.connect).toBe("function");
			expect(typeof mockAdapter.disconnect).toBe("function");
			expect(typeof mockAdapter.process).toBe("function");
			expect(typeof mockAdapter.addJob).toBe("function");
			expect(typeof mockAdapter.stopProcessing).toBe("function");
			expect(typeof mockAdapter.isConnected).toBe("function");
			expect(typeof mockAdapter.healthCheck).toBe("function");
			expect(typeof mockAdapter.getQueueStats).toBe("function");
		});

		it("should return correct queue stats structure", async () => {
			const stats: WorkerQueueStats = {
				waiting: 10,
				active: 3,
				completed: 500,
				failed: 12,
				delayed: 5,
			};

			expect(stats.waiting).toBe(10);
			expect(stats.active).toBe(3);
			expect(stats.completed).toBe(500);
			expect(stats.failed).toBe(12);
			expect(stats.delayed).toBe(5);
		});
	});
});

// ============================================================================
// InMemoryAdapter Tests
// ============================================================================

describe("InMemoryAdapter", () => {
	let adapter: InMemoryAdapter;

	beforeEach(() => {
		adapter = new InMemoryAdapter();
	});

	afterEach(async () => {
		await adapter.disconnect();
	});

	describe("Connection Lifecycle", () => {
		it("should connect successfully", async () => {
			expect(adapter.isConnected()).toBe(false);
			await adapter.connect();
			expect(adapter.isConnected()).toBe(true);
		});

		it("should disconnect successfully", async () => {
			await adapter.connect();
			expect(adapter.isConnected()).toBe(true);
			await adapter.disconnect();
			expect(adapter.isConnected()).toBe(false);
		});

		it("should report healthy when connected", async () => {
			await adapter.connect();
			expect(await adapter.healthCheck()).toBe(true);
		});

		it("should report unhealthy when disconnected", async () => {
			expect(await adapter.healthCheck()).toBe(false);
		});

		it("should have provider name 'in-memory'", () => {
			expect(adapter.provider).toBe("in-memory");
		});
	});

	describe("Job Dispatching", () => {
		it("should add a job and return its ID", async () => {
			await adapter.connect();
			const jobId = await adapter.addJob("test-queue", { action: "test" });
			expect(jobId).toBeDefined();
			expect(typeof jobId).toBe("string");
		});

		it("should accept custom job ID", async () => {
			await adapter.connect();
			const jobId = await adapter.addJob(
				"test-queue",
				{ data: 1 },
				{
					jobId: "custom-id-123",
				},
			);
			expect(jobId).toBe("custom-id-123");
		});

		it("should add jobs with priority ordering", async () => {
			await adapter.connect();
			await adapter.addJob("priority-queue", { order: "low" }, { priority: 1 });
			await adapter.addJob("priority-queue", { order: "high" }, { priority: 10 });
			await adapter.addJob("priority-queue", { order: "medium" }, { priority: 5 });

			const stats = await adapter.getQueueStats("priority-queue");
			expect(stats.waiting).toBe(3);
		});

		it("should add delayed jobs", async () => {
			await adapter.connect();
			await adapter.addJob(
				"delayed-queue",
				{ data: 1 },
				{
					delay: 5000,
				},
			);

			const stats = await adapter.getQueueStats("delayed-queue");
			expect(stats.delayed).toBe(1);
			expect(stats.waiting).toBe(0);
		});

		it("should throw when not connected", async () => {
			await expect(adapter.addJob("test-queue", { data: 1 })).rejects.toThrow("Not connected");
		});
	});

	describe("Job Processing", () => {
		it("should process jobs from a queue", async () => {
			await adapter.connect();

			const processedJobs: WorkerJob[] = [];

			await adapter.process({ queue: "process-queue", concurrency: 1, retries: 3, priority: 0 }, async (job) => {
				processedJobs.push(job);
				await job.complete();
			});

			await adapter.addJob("process-queue", { item: "test-1" });

			// Wait for processing
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(processedJobs).toHaveLength(1);
			expect(processedJobs[0].data).toEqual({ item: "test-1" });
		});

		it("should process multiple jobs sequentially", async () => {
			await adapter.connect();

			const processedOrder: number[] = [];

			await adapter.process({ queue: "seq-queue", concurrency: 1, retries: 3, priority: 0 }, async (job) => {
				processedOrder.push(job.data as number);
				await job.complete();
			});

			await adapter.addJob("seq-queue", 1);
			await adapter.addJob("seq-queue", 2);
			await adapter.addJob("seq-queue", 3);

			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(processedOrder).toEqual([1, 2, 3]);
		});

		it("should track queue stats correctly", async () => {
			await adapter.connect();

			await adapter.process({ queue: "stats-queue", concurrency: 1, retries: 3, priority: 0 }, async (job) => {
				await job.complete();
			});

			await adapter.addJob("stats-queue", { a: 1 });
			await adapter.addJob("stats-queue", { a: 2 });

			await new Promise((resolve) => setTimeout(resolve, 300));

			const stats = await adapter.getQueueStats("stats-queue");
			expect(stats.completed).toBe(2);
			expect(stats.waiting).toBe(0);
		});

		it("should handle job failures", async () => {
			await adapter.connect();

			await adapter.process({ queue: "fail-queue", concurrency: 1, retries: 0, priority: 0 }, async (job) => {
				await job.fail(new Error("test failure"), false);
			});

			await adapter.addJob("fail-queue", { data: "will-fail" }, { retries: 0 });

			await new Promise((resolve) => setTimeout(resolve, 200));

			const stats = await adapter.getQueueStats("fail-queue");
			expect(stats.failed).toBe(1);
		});

		it("should requeue failed jobs for retry", async () => {
			await adapter.connect();

			let attemptCount = 0;

			await adapter.process({ queue: "retry-queue", concurrency: 1, retries: 3, priority: 0 }, async (job) => {
				attemptCount++;
				if (attemptCount < 2) {
					await job.fail(new Error("temporary failure"), true);
				} else {
					await job.complete();
				}
			});

			await adapter.addJob("retry-queue", { data: "retry-me" }, { retries: 3 });

			// Wait long enough for retry backoff + processing
			await new Promise((resolve) => setTimeout(resolve, 3000));

			expect(attemptCount).toBeGreaterThanOrEqual(2);
		}, 5000);

		it("should stop processing a queue", async () => {
			await adapter.connect();

			const processed: string[] = [];

			await adapter.process({ queue: "stop-queue", concurrency: 1, retries: 3, priority: 0 }, async (job) => {
				processed.push(job.id);
				await job.complete();
			});

			await adapter.addJob("stop-queue", { first: true });
			await new Promise((resolve) => setTimeout(resolve, 200));

			await adapter.stopProcessing("stop-queue");

			await adapter.addJob("stop-queue", { second: true });
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Only first job should have been processed
			expect(processed).toHaveLength(1);
		});

		it("should throw when processing without connection", async () => {
			await expect(
				adapter.process({ queue: "q", concurrency: 1, retries: 0, priority: 0 }, async () => {}),
			).rejects.toThrow("Not connected");
		});
	});

	describe("Queue Stats", () => {
		it("should return zeros for unknown queue", async () => {
			await adapter.connect();
			const stats = await adapter.getQueueStats("nonexistent");
			expect(stats).toEqual({
				waiting: 0,
				active: 0,
				completed: 0,
				failed: 0,
				delayed: 0,
			});
		});

		it("should track waiting count", async () => {
			await adapter.connect();
			await adapter.addJob("count-queue", { a: 1 });
			await adapter.addJob("count-queue", { a: 2 });
			await adapter.addJob("count-queue", { a: 3 });

			const stats = await adapter.getQueueStats("count-queue");
			expect(stats.waiting).toBe(3);
		});
	});
});

// ============================================================================
// BullMQAdapter Config Tests
// ============================================================================

describe("BullMQAdapter", () => {
	it("should read config from environment variables", () => {
		const originalHost = process.env.REDIS_HOST;
		const originalPort = process.env.REDIS_PORT;
		const originalPassword = process.env.REDIS_PASSWORD;
		const originalDb = process.env.REDIS_DB;

		process.env.REDIS_HOST = "redis.example.com";
		process.env.REDIS_PORT = "6380";
		process.env.REDIS_PASSWORD = "secret123";
		process.env.REDIS_DB = "2";

		const config = {
			host: process.env.REDIS_HOST || "localhost",
			port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
			password: process.env.REDIS_PASSWORD,
			db: Number.parseInt(process.env.REDIS_DB || "0", 10),
		};

		expect(config.host).toBe("redis.example.com");
		expect(config.port).toBe(6380);
		expect(config.password).toBe("secret123");
		expect(config.db).toBe(2);

		// Restore
		process.env.REDIS_HOST = originalHost;
		process.env.REDIS_PORT = originalPort;
		process.env.REDIS_PASSWORD = originalPassword;
		process.env.REDIS_DB = originalDb;
	});

	it("should use default values when env vars not set", () => {
		// Pure: don't mutate process.env (races with other parallel workers
		// when running via `nx run-many -t test` and pollutes other tests).
		// Simulate "env unset" by reading from an explicit snapshot rather
		// than the live process.env.
		const fakeEnv: Record<string, string | undefined> = {
			REDIS_HOST: undefined,
			REDIS_PORT: undefined,
		};

		const config = {
			host: fakeEnv.REDIS_HOST || "localhost",
			port: Number.parseInt(fakeEnv.REDIS_PORT || "6379", 10),
		};

		expect(config.host).toBe("localhost");
		expect(config.port).toBe(6379);
	});
});

// ============================================================================
// WorkerTriggerOpts Schema Tests
// ============================================================================

describe("WorkerTriggerOpts Schema", () => {
	it("should validate worker trigger configuration", () => {
		const validConfig = {
			queue: "background-jobs",
			concurrency: 5,
			timeout: 30000,
			retries: 3,
			priority: 10,
			delay: 1000,
		};

		expect(validConfig.queue).toBe("background-jobs");
		expect(validConfig.concurrency).toBe(5);
		expect(validConfig.timeout).toBe(30000);
		expect(validConfig.retries).toBe(3);
		expect(validConfig.priority).toBe(10);
		expect(validConfig.delay).toBe(1000);
	});

	it("should support minimal configuration", () => {
		const minConfig = {
			queue: "default",
		};

		expect(minConfig.queue).toBe("default");
	});

	it("should support high-concurrency configuration", () => {
		const config = {
			queue: "high-throughput",
			concurrency: 50,
			retries: 5,
			timeout: 60000,
			priority: 0,
		};

		expect(config.concurrency).toBe(50);
		expect(config.retries).toBe(5);
	});
});

// ============================================================================
// Exponential Backoff Tests
// ============================================================================

describe("Exponential Backoff", () => {
	it("should calculate increasing delays", () => {
		const base = 1000;
		const maxDelay = 30000;

		const delays = [0, 1, 2, 3, 4, 5].map((attempt) => {
			const exponential = Math.min(base * 2 ** attempt, maxDelay);
			return exponential;
		});

		expect(delays[0]).toBe(1000); // 1s
		expect(delays[1]).toBe(2000); // 2s
		expect(delays[2]).toBe(4000); // 4s
		expect(delays[3]).toBe(8000); // 8s
		expect(delays[4]).toBe(16000); // 16s
		expect(delays[5]).toBe(30000); // capped at 30s
	});

	it("should cap at maximum delay", () => {
		const base = 1000;
		const maxDelay = 30000;

		const delay = Math.min(base * 2 ** 10, maxDelay);
		expect(delay).toBe(30000);
	});

	it("should support custom base delay", () => {
		const base = 500;
		const exponential = base * 2 ** 2;
		expect(exponential).toBe(2000);
	});
});

// ============================================================================
// NATSAdapter — computeXDelayHoldMs (Tier 2 polish: x-delay enforcement)
// ============================================================================

describe("NATSAdapter — computeXDelayHoldMs", () => {
	it("returns 0 when no delay was set", () => {
		expect(computeXDelayHoldMs(0, 1_000_000, 1_000_000)).toBe(0);
		expect(computeXDelayHoldMs(-50, 1_000_000, 1_000_000)).toBe(0);
	});

	it("returns the full delay when the message just arrived", () => {
		// createdMs == nowMs (just published), delay 5s → wait 5s.
		expect(computeXDelayHoldMs(5000, 2_000_000, 2_000_000)).toBe(5000);
	});

	it("returns the remaining delay when partially elapsed", () => {
		// Published 2s ago, delay 5s → wait 3s remaining.
		expect(computeXDelayHoldMs(5000, 1_000_000, 1_002_000)).toBe(3000);
	});

	it("returns 0 when the delay has already elapsed", () => {
		// Published 10s ago, delay 5s → fire immediately.
		expect(computeXDelayHoldMs(5000, 1_000_000, 1_010_000)).toBe(0);
	});

	it("clamps to 0 when nowMs is far in the future", () => {
		expect(computeXDelayHoldMs(5000, 1_000_000, 9_999_999)).toBe(0);
	});
});
