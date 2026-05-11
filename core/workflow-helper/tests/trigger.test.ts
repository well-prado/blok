import { describe, expect, it } from "vitest";
import StepNode from "../src/components/StepNode";
import Workflow from "../src/components/Workflow";

describe("Trigger.addTrigger()", () => {
	function createWorkflow() {
		return Workflow({ name: "test-workflow", version: "1.0.0" });
	}

	describe("trigger name validation", () => {
		it("rejects an unknown trigger name", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("invalid" as unknown as "http", { method: "GET" })).toThrow();
		});
	});

	describe("schemaless triggers (grpc, manual)", () => {
		it("accepts grpc with no config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("grpc");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("accepts manual with no config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("manual");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("accepts grpc with arbitrary config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("grpc", { service: "UserService", method: "GetUser" });
			expect(step).toBeInstanceOf(StepNode);
			const json = JSON.parse(step.toJson());
			expect(json.trigger.grpc.service).toBe("UserService");
		});
	});

	describe("http trigger", () => {
		it("accepts a valid http config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("http", { method: "GET", path: "/" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("stores the http trigger in the workflow config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("http", { method: "POST", path: "/api" });
			const json = JSON.parse(step.toJson());
			expect(json.trigger).toBeDefined();
			expect(json.trigger.http).toBeDefined();
			expect(json.trigger.http.method).toBe("POST");
		});

		it("applies the default 'accept' value", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("http", { method: "GET", path: "/" });
			const json = JSON.parse(step.toJson());
			expect(json.trigger.http.accept).toBe("application/json");
		});

		it("rejects an invalid HTTP method", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("http", { method: "INVALID" as unknown as "GET" })).toThrow();
		});
	});

	describe("cron trigger", () => {
		it("accepts a valid cron config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("cron", { schedule: "0 * * * *" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("rejects cron when no config is provided", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("cron" as unknown as "grpc")).toThrow(/requires a configuration object/);
		});

		it("rejects cron with a non-string schedule", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("cron", { schedule: 123 as unknown as string })).toThrow();
		});

		it("applies default timezone", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("cron", { schedule: "0 * * * *" });
			const json = JSON.parse(step.toJson());
			expect(json.trigger.cron.timezone).toBe("UTC");
		});
	});

	describe("queue trigger", () => {
		it("accepts a valid queue config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("queue", { provider: "kafka", topic: "events" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("rejects queue when no config is provided", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("queue" as unknown as "grpc")).toThrow(/requires a configuration object/);
		});

		it("rejects queue with an invalid provider", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("queue", { provider: "mq" as unknown as "kafka", topic: "events" })).toThrow();
		});

		it("applies queue defaults (ack, maxRetries, batchSize, concurrency)", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("queue", { provider: "nats", topic: "jobs" });
			const json = JSON.parse(step.toJson());
			expect(json.trigger.queue.ack).toBe(true);
			expect(json.trigger.queue.maxRetries).toBe(3);
			expect(json.trigger.queue.batchSize).toBe(1);
			expect(json.trigger.queue.concurrency).toBe(1);
		});
	});

	describe("pubsub trigger", () => {
		it("accepts a valid pubsub config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("pubsub", {
				provider: "gcp",
				topic: "updates",
				subscription: "sub-1",
			});
			expect(step).toBeInstanceOf(StepNode);
		});

		it("rejects pubsub missing required subscription", () => {
			const trigger = createWorkflow();
			expect(() =>
				trigger.addTrigger("pubsub", {
					provider: "aws",
					topic: "updates",
				} as unknown as { provider: "aws"; topic: string; subscription: string }),
			).toThrow();
		});
	});

	describe("worker trigger", () => {
		it("accepts a valid worker config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("worker", { queue: "background-jobs" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("rejects worker when no config is provided", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("worker" as unknown as "grpc")).toThrow(/requires a configuration object/);
		});

		it("applies worker defaults (concurrency, retries)", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("worker", { queue: "jobs" });
			const json = JSON.parse(step.toJson());
			expect(json.trigger.worker.concurrency).toBe(1);
			expect(json.trigger.worker.retries).toBe(3);
		});
	});

	describe("webhook trigger", () => {
		it("accepts a built-in provider config (v0.7)", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("webhook", {
				provider: "github",
				path: "/webhooks/github",
				secretEnv: "GITHUB_WEBHOOK_SECRET",
				events: ["push", "pull_request"],
			});
			expect(step).toBeInstanceOf(StepNode);
		});

		it("accepts a custom-signature config (unknown provider)", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("webhook", {
				path: "/webhooks/acme",
				signature: {
					scheme: "hmac-sha256",
					header: "X-Acme-Signature",
					format: "{hex}",
					secretEnv: "ACME_SECRET",
					tolerance: 300,
					timestampHeader: "X-Acme-Timestamp",
				},
			});
			expect(step).toBeInstanceOf(StepNode);
		});

		it("rejects webhook when no config is provided", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("webhook" as unknown as "grpc")).toThrow(/requires a configuration object/);
		});

		it("rejects an unknown provider value", () => {
			const trigger = createWorkflow();
			expect(() =>
				trigger.addTrigger("webhook", {
					provider: "not-a-provider",
				} as unknown as { provider: "github" }),
			).toThrow();
		});
	});

	describe("sse trigger", () => {
		it("accepts a valid sse config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("sse", { events: ["update"], path: "/stream" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("applies sse defaults", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("sse", { events: ["update"] });
			const json = JSON.parse(step.toJson());
			expect(json.trigger.sse.maxConnections).toBe(10000);
			expect(json.trigger.sse.heartbeatInterval).toBe(30000);
			expect(json.trigger.sse.retryInterval).toBe(3000);
		});
	});

	describe("websocket trigger", () => {
		it("accepts a valid websocket config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("websocket", { events: ["message"], path: "/ws" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("applies websocket defaults", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("websocket", { events: ["message"] });
			const json = JSON.parse(step.toJson());
			expect(json.trigger.websocket.maxConnections).toBe(10000);
			expect(json.trigger.websocket.heartbeatInterval).toBe(30000);
			expect(json.trigger.websocket.messageRateLimit).toBe(100);
		});
	});
});
