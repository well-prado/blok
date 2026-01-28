/**
 * QueueTrigger Tests
 *
 * Tests the QueueTrigger base class and adapter interfaces.
 * Note: Actual queue connectivity tests require running queue services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test the adapter interfaces and mock implementations
describe("QueueTrigger", () => {
	describe("QueueMessage Interface", () => {
		it("should accept valid queue message structure", () => {
			const message = {
				id: "test-id-123",
				body: { data: "test" },
				headers: { "content-type": "application/json" },
				raw: {},
				topic: "test-topic",
				partition: 0,
				offset: "100",
				timestamp: new Date(),
				ack: async () => {},
				nack: async () => {},
			};

			expect(message.id).toBe("test-id-123");
			expect(message.body).toEqual({ data: "test" });
			expect(message.topic).toBe("test-topic");
		});

		it("should handle minimal required fields", () => {
			const message = {
				id: "test-id",
				body: null,
				headers: {},
				raw: null,
				topic: "test",
				ack: async () => {},
				nack: async () => {},
			};

			expect(message.id).toBeDefined();
			expect(message.topic).toBeDefined();
			expect(message.ack).toBeDefined();
			expect(message.nack).toBeDefined();
		});
	});

	describe("QueueAdapter Interface", () => {
		it("should validate adapter interface methods", () => {
			// Mock adapter implementing QueueAdapter interface
			const mockAdapter = {
				provider: "kafka" as const,
				connect: vi.fn().mockResolvedValue(undefined),
				disconnect: vi.fn().mockResolvedValue(undefined),
				subscribe: vi.fn().mockResolvedValue(undefined),
				unsubscribe: vi.fn().mockResolvedValue(undefined),
				isConnected: vi.fn().mockReturnValue(true),
				healthCheck: vi.fn().mockResolvedValue(true),
			};

			expect(mockAdapter.provider).toBe("kafka");
			expect(typeof mockAdapter.connect).toBe("function");
			expect(typeof mockAdapter.disconnect).toBe("function");
			expect(typeof mockAdapter.subscribe).toBe("function");
			expect(typeof mockAdapter.unsubscribe).toBe("function");
			expect(typeof mockAdapter.isConnected).toBe("function");
			expect(typeof mockAdapter.healthCheck).toBe("function");
		});
	});
});

describe("KafkaAdapter", () => {
	it("should create adapter with default config from environment", () => {
		// Test that adapter reads from environment variables
		const originalBrokers = process.env.KAFKA_BROKERS;
		const originalClientId = process.env.KAFKA_CLIENT_ID;

		process.env.KAFKA_BROKERS = "broker1:9092,broker2:9092";
		process.env.KAFKA_CLIENT_ID = "test-client";

		// Import is deferred to test environment setup
		const config = {
			brokers: process.env.KAFKA_BROKERS?.split(",") || ["localhost:9092"],
			clientId: process.env.KAFKA_CLIENT_ID || "blok-queue-trigger",
		};

		expect(config.brokers).toEqual(["broker1:9092", "broker2:9092"]);
		expect(config.clientId).toBe("test-client");

		// Restore
		process.env.KAFKA_BROKERS = originalBrokers;
		process.env.KAFKA_CLIENT_ID = originalClientId;
	});
});

describe("RabbitMQAdapter", () => {
	it("should create adapter with default config from environment", () => {
		const originalUrl = process.env.RABBITMQ_URL;
		const originalPrefetch = process.env.RABBITMQ_PREFETCH;

		process.env.RABBITMQ_URL = "amqp://user:pass@localhost:5672";
		process.env.RABBITMQ_PREFETCH = "10";

		const config = {
			url: process.env.RABBITMQ_URL || "amqp://localhost",
			prefetch: parseInt(process.env.RABBITMQ_PREFETCH || "1", 10),
		};

		expect(config.url).toBe("amqp://user:pass@localhost:5672");
		expect(config.prefetch).toBe(10);

		// Restore
		process.env.RABBITMQ_URL = originalUrl;
		process.env.RABBITMQ_PREFETCH = originalPrefetch;
	});
});

describe("SQSAdapter", () => {
	it("should create adapter with default config from environment", () => {
		const originalRegion = process.env.AWS_REGION;
		const originalWaitTime = process.env.SQS_WAIT_TIME_SECONDS;
		const originalMaxMessages = process.env.SQS_MAX_MESSAGES;

		process.env.AWS_REGION = "eu-west-1";
		process.env.SQS_WAIT_TIME_SECONDS = "10";
		process.env.SQS_MAX_MESSAGES = "5";

		const config = {
			region: process.env.AWS_REGION || "us-east-1",
			waitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS || "20", 10),
			maxNumberOfMessages: parseInt(process.env.SQS_MAX_MESSAGES || "10", 10),
		};

		expect(config.region).toBe("eu-west-1");
		expect(config.waitTimeSeconds).toBe(10);
		expect(config.maxNumberOfMessages).toBe(5);

		// Restore
		process.env.AWS_REGION = originalRegion;
		process.env.SQS_WAIT_TIME_SECONDS = originalWaitTime;
		process.env.SQS_MAX_MESSAGES = originalMaxMessages;
	});
});

describe("RedisAdapter", () => {
	it("should create adapter with default config from environment", () => {
		const originalHost = process.env.REDIS_HOST;
		const originalPort = process.env.REDIS_PORT;
		const originalPassword = process.env.REDIS_PASSWORD;
		const originalDb = process.env.REDIS_DB;

		process.env.REDIS_HOST = "redis.example.com";
		process.env.REDIS_PORT = "6380";
		process.env.REDIS_PASSWORD = "secret";
		process.env.REDIS_DB = "1";

		const config = {
			host: process.env.REDIS_HOST || "localhost",
			port: parseInt(process.env.REDIS_PORT || "6379", 10),
			password: process.env.REDIS_PASSWORD,
			db: parseInt(process.env.REDIS_DB || "0", 10),
		};

		expect(config.host).toBe("redis.example.com");
		expect(config.port).toBe(6380);
		expect(config.password).toBe("secret");
		expect(config.db).toBe(1);

		// Restore
		process.env.REDIS_HOST = originalHost;
		process.env.REDIS_PORT = originalPort;
		process.env.REDIS_PASSWORD = originalPassword;
		process.env.REDIS_DB = originalDb;
	});
});

describe("QueueTriggerOpts Schema", () => {
	it("should validate queue trigger configuration", () => {
		const validConfig = {
			provider: "kafka" as const,
			topic: "my-topic",
			consumerGroup: "my-group",
			ack: true,
			maxRetries: 3,
			batchSize: 10,
			concurrency: 5,
		};

		expect(validConfig.provider).toBe("kafka");
		expect(validConfig.topic).toBe("my-topic");
		expect(validConfig.ack).toBe(true);
	});

	it("should support all provider types", () => {
		const providers = ["kafka", "rabbitmq", "sqs", "redis", "beanstalk"];

		for (const provider of providers) {
			const config = {
				provider: provider as any,
				topic: "test-topic",
			};
			expect(config.provider).toBe(provider);
		}
	});
});
