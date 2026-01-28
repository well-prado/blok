import { describe, expect, it } from "vitest";
import { NodeTypeSchema, RuntimeKindSchema, StepConditionSchema, StepOptsSchema } from "../src/types/StepOpts";
import {
	CronTriggerOptsSchema,
	HttpTriggerOptsSchema,
	QueueTriggerOptsSchema,
	TriggersSchema,
	WebhookTriggerOptsSchema,
} from "../src/types/TriggerOpts";
import { WorkflowOptsSchema } from "../src/types/WorkflowOpts";

describe("WorkflowOptsSchema", () => {
	it("should require name >= 3 chars", () => {
		expect(() => WorkflowOptsSchema.parse({ name: "ab", version: "1.0.0" })).toThrow();
		expect(() => WorkflowOptsSchema.parse({ name: "abc", version: "1.0.0" })).not.toThrow();
	});

	it("should require version >= 5 chars (x.x.x)", () => {
		expect(() => WorkflowOptsSchema.parse({ name: "test", version: "1.0" })).toThrow();
		expect(() => WorkflowOptsSchema.parse({ name: "test", version: "1.0.0" })).not.toThrow();
	});

	it("should allow optional description", () => {
		const result = WorkflowOptsSchema.parse({ name: "test", version: "1.0.0" });
		expect(result.description).toBeUndefined();

		const withDesc = WorkflowOptsSchema.parse({ name: "test", version: "1.0.0", description: "hello" });
		expect(withDesc.description).toBe("hello");
	});
});

describe("StepOptsSchema", () => {
	it("should require name >= 3 chars", () => {
		expect(() => StepOptsSchema.parse({ name: "ab", node: "my-node-name", type: "module" })).toThrow();
	});

	it("should require node >= 5 chars", () => {
		expect(() => StepOptsSchema.parse({ name: "step", node: "nd", type: "module" })).toThrow();
	});

	it("should require valid type enum", () => {
		expect(() => StepOptsSchema.parse({ name: "step", node: "my-node-name", type: "invalid" })).toThrow();
		expect(() => StepOptsSchema.parse({ name: "step", node: "my-node-name", type: "local" })).not.toThrow();
		expect(() => StepOptsSchema.parse({ name: "step", node: "my-node-name", type: "module" })).not.toThrow();
	});

	it("should allow optional inputs", () => {
		const result = StepOptsSchema.parse({ name: "step", node: "my-node-name", type: "module" });
		expect(result.inputs).toBeUndefined();
	});

	it("should allow optional runtime", () => {
		const result = StepOptsSchema.parse({ name: "step", node: "my-node-name", type: "runtime.go", runtime: "go" });
		expect(result.runtime).toBe("go");
	});
});

describe("NodeTypeSchema", () => {
	it("should accept all valid node types", () => {
		const validTypes = [
			"local",
			"module",
			"runtime.python3",
			"runtime.nodejs",
			"runtime.bun",
			"runtime.go",
			"runtime.java",
			"runtime.rust",
			"runtime.php",
			"runtime.csharp",
			"runtime.ruby",
			"runtime.docker",
			"runtime.wasm",
		];
		for (const type of validTypes) {
			expect(() => NodeTypeSchema.parse(type)).not.toThrow();
		}
	});

	it("should reject invalid types", () => {
		expect(() => NodeTypeSchema.parse("invalid")).toThrow();
	});
});

describe("RuntimeKindSchema", () => {
	it("should accept all valid runtime kinds", () => {
		const validKinds = ["nodejs", "bun", "python3", "go", "java", "rust", "php", "csharp", "ruby", "docker", "wasm"];
		for (const kind of validKinds) {
			expect(() => RuntimeKindSchema.parse(kind)).not.toThrow();
		}
	});
});

describe("TriggersSchema", () => {
	it("should accept all valid trigger types", () => {
		const validTriggers = [
			"http",
			"grpc",
			"manual",
			"cron",
			"queue",
			"pubsub",
			"worker",
			"webhook",
			"sse",
			"websocket",
		];
		for (const trigger of validTriggers) {
			expect(() => TriggersSchema.parse(trigger)).not.toThrow();
		}
	});

	it("should reject invalid trigger types", () => {
		expect(() => TriggersSchema.parse("invalid")).toThrow();
	});
});

describe("HttpTriggerOptsSchema", () => {
	it("should validate HTTP trigger options", () => {
		expect(() => HttpTriggerOptsSchema.parse({ method: "GET" })).not.toThrow();
		expect(() => HttpTriggerOptsSchema.parse({ method: "POST", path: "/api" })).not.toThrow();
	});

	it("should require valid method", () => {
		expect(() => HttpTriggerOptsSchema.parse({ method: "INVALID" })).toThrow();
	});
});

describe("QueueTriggerOptsSchema", () => {
	it("should validate queue trigger options", () => {
		const result = QueueTriggerOptsSchema.parse({ provider: "kafka", topic: "my-topic" });
		expect(result.provider).toBe("kafka");
		expect(result.topic).toBe("my-topic");
		expect(result.ack).toBe(true); // default
	});
});

describe("CronTriggerOptsSchema", () => {
	it("should validate cron trigger options", () => {
		const result = CronTriggerOptsSchema.parse({ schedule: "0 * * * *" });
		expect(result.schedule).toBe("0 * * * *");
		expect(result.timezone).toBe("UTC"); // default
	});
});

describe("WebhookTriggerOptsSchema", () => {
	it("should validate webhook trigger options", () => {
		const result = WebhookTriggerOptsSchema.parse({ source: "github", events: ["push", "pull_request"] });
		expect(result.source).toBe("github");
		expect(result.events).toEqual(["push", "pull_request"]);
	});
});

describe("StepConditionSchema", () => {
	it("should validate step condition", () => {
		const result = StepConditionSchema.parse({
			node: { name: "cond-node", node: "control-flow/if-else@1.0.0", type: "local" },
		});
		expect(result.node.name).toBe("cond-node");
	});
});
