import { describe, expect, it } from "vitest";
import { NodeTypeSchema, RuntimeKindSchema, StepConditionSchema, StepOptsSchema } from "../src/types/StepOpts";
import {
	CronTriggerOptsSchema,
	HttpTriggerOptsSchema,
	QueueTriggerOptsSchema,
	TRIGGER_SCHEMAS,
	TriggersSchema,
	WebhookTriggerOptsSchema,
	validateTriggerConfig,
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

	it("should allow optional set_var, active, stop", () => {
		const result = StepOptsSchema.parse({
			name: "step",
			node: "my-node-name",
			type: "module",
			set_var: true,
			active: false,
			stop: true,
		});
		expect(result.set_var).toBe(true);
		expect(result.active).toBe(false);
		expect(result.stop).toBe(true);
	});

	it("should reject non-boolean set_var", () => {
		expect(() =>
			StepOptsSchema.parse({ name: "step", node: "my-node-name", type: "module", set_var: "yes" }),
		).toThrow();
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

describe("TRIGGER_SCHEMAS", () => {
	it("has an entry for every trigger name", () => {
		for (const name of TriggersSchema.options) {
			expect(TRIGGER_SCHEMAS).toHaveProperty(name);
		}
	});

	it("returns null for schemaless triggers", () => {
		expect(TRIGGER_SCHEMAS.grpc).toBeNull();
		expect(TRIGGER_SCHEMAS.manual).toBeNull();
	});

	it("returns a schema for typed triggers", () => {
		expect(TRIGGER_SCHEMAS.http).not.toBeNull();
		expect(TRIGGER_SCHEMAS.cron).not.toBeNull();
		expect(TRIGGER_SCHEMAS.queue).not.toBeNull();
	});
});

describe("validateTriggerConfig", () => {
	it("returns an empty object for grpc/manual when given undefined", () => {
		expect(validateTriggerConfig("grpc", undefined)).toEqual({});
		expect(validateTriggerConfig("manual", undefined)).toEqual({});
	});

	it("returns the provided config for grpc/manual when given an object", () => {
		const cfg = { service: "UserService" };
		expect(validateTriggerConfig("grpc", cfg)).toEqual(cfg);
	});

	it("throws when a typed trigger is missing its config", () => {
		expect(() => validateTriggerConfig("cron", undefined)).toThrow(/requires a configuration object/);
		expect(() => validateTriggerConfig("queue", undefined)).toThrow(/requires a configuration object/);
		expect(() => validateTriggerConfig("worker", undefined)).toThrow(/requires a configuration object/);
	});

	it("applies defaults from the schema", () => {
		const result = validateTriggerConfig("cron", { schedule: "0 * * * *" }) as {
			timezone: string;
			overlap: boolean;
		};
		expect(result.timezone).toBe("UTC");
		expect(result.overlap).toBe(false);
	});

	it("rejects invalid configs", () => {
		expect(() => validateTriggerConfig("cron", { schedule: 123 })).toThrow();
		expect(() => validateTriggerConfig("queue", { provider: "unknown", topic: "x" })).toThrow();
	});
});
