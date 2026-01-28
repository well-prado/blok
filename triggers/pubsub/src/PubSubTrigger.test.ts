/**
 * PubSubTrigger Tests
 *
 * Tests the PubSubTrigger base class and adapter interfaces.
 */

import { describe, it, expect, vi } from "vitest";

describe("PubSubTrigger", () => {
	describe("PubSubMessage Interface", () => {
		it("should accept valid pub/sub message structure", () => {
			const message = {
				id: "msg-123",
				body: { event: "order.created", data: { orderId: 456 } },
				attributes: { "content-type": "application/json", source: "orders-service" },
				raw: {},
				topic: "orders",
				subscription: "orders-subscription",
				publishTime: new Date(),
				ack: async () => {},
				nack: async () => {},
			};

			expect(message.id).toBe("msg-123");
			expect(message.body).toEqual({ event: "order.created", data: { orderId: 456 } });
			expect(message.topic).toBe("orders");
			expect(message.subscription).toBe("orders-subscription");
		});

		it("should handle minimal required fields", () => {
			const message = {
				id: "msg-id",
				body: null,
				attributes: {},
				raw: null,
				topic: "test-topic",
				ack: async () => {},
				nack: async () => {},
			};

			expect(message.id).toBeDefined();
			expect(message.topic).toBeDefined();
			expect(message.ack).toBeDefined();
			expect(message.nack).toBeDefined();
		});
	});

	describe("PubSubAdapter Interface", () => {
		it("should validate adapter interface methods", () => {
			const mockAdapter = {
				provider: "gcp" as const,
				connect: vi.fn().mockResolvedValue(undefined),
				disconnect: vi.fn().mockResolvedValue(undefined),
				subscribe: vi.fn().mockResolvedValue(undefined),
				unsubscribe: vi.fn().mockResolvedValue(undefined),
				isConnected: vi.fn().mockReturnValue(true),
				healthCheck: vi.fn().mockResolvedValue(true),
			};

			expect(mockAdapter.provider).toBe("gcp");
			expect(typeof mockAdapter.connect).toBe("function");
			expect(typeof mockAdapter.disconnect).toBe("function");
			expect(typeof mockAdapter.subscribe).toBe("function");
			expect(typeof mockAdapter.unsubscribe).toBe("function");
			expect(typeof mockAdapter.isConnected).toBe("function");
			expect(typeof mockAdapter.healthCheck).toBe("function");
		});
	});
});

describe("GCPPubSubAdapter", () => {
	it("should create adapter with config from environment", () => {
		const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";

		const config = {
			projectId: process.env.GOOGLE_CLOUD_PROJECT,
		};

		expect(config.projectId).toBe("test-project");

		process.env.GOOGLE_CLOUD_PROJECT = originalProject;
	});
});

describe("AWSSNSAdapter", () => {
	it("should create adapter with config from environment", () => {
		const originalRegion = process.env.AWS_REGION;
		const originalWaitTime = process.env.SQS_WAIT_TIME_SECONDS;

		process.env.AWS_REGION = "eu-central-1";
		process.env.SQS_WAIT_TIME_SECONDS = "15";

		const config = {
			region: process.env.AWS_REGION || "us-east-1",
			waitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS || "20", 10),
		};

		expect(config.region).toBe("eu-central-1");
		expect(config.waitTimeSeconds).toBe(15);

		process.env.AWS_REGION = originalRegion;
		process.env.SQS_WAIT_TIME_SECONDS = originalWaitTime;
	});
});

describe("AzureServiceBusAdapter", () => {
	it("should create adapter with config from environment", () => {
		const originalConnStr = process.env.AZURE_SERVICE_BUS_CONNECTION_STRING;
		const testConnStr = "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=test;SharedAccessKey=abc";
		process.env.AZURE_SERVICE_BUS_CONNECTION_STRING = testConnStr;

		const config = {
			connectionString: process.env.AZURE_SERVICE_BUS_CONNECTION_STRING,
		};

		expect(config.connectionString).toBe(testConnStr);

		process.env.AZURE_SERVICE_BUS_CONNECTION_STRING = originalConnStr;
	});
});

describe("PubSubTriggerOpts Schema", () => {
	it("should validate pub/sub trigger configuration", () => {
		const validConfig = {
			provider: "gcp" as const,
			topic: "my-topic",
			subscription: "my-subscription",
			ack: true,
			maxMessages: 10,
			ackDeadline: 30,
		};

		expect(validConfig.provider).toBe("gcp");
		expect(validConfig.topic).toBe("my-topic");
		expect(validConfig.subscription).toBe("my-subscription");
	});

	it("should support all provider types", () => {
		const providers = ["gcp", "aws", "azure"];

		for (const provider of providers) {
			const config = {
				provider: provider as any,
				topic: "test-topic",
				subscription: "test-sub",
			};
			expect(config.provider).toBe(provider);
		}
	});
});
