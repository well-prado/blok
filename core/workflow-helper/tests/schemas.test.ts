import { describe, expect, it } from "vitest";
import {
	NodeTypeSchema,
	RetryConfigSchema,
	RuntimeKindSchema,
	StepConditionSchema,
	StepOptsSchema,
	V2RegularStepSchema,
	V2SubworkflowStepSchema,
} from "../src/types/StepOpts";
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

describe("V2RegularStepSchema — idempotencyKey + retry", () => {
	const baseStep = { id: "fetch", use: "@blokjs/api-call" };

	it("accepts a non-empty idempotencyKey string", () => {
		const result = V2RegularStepSchema.parse({ ...baseStep, idempotencyKey: "user-123" });
		expect(result.idempotencyKey).toBe("user-123");
	});

	it("accepts a js-expression-style idempotencyKey (string compiled from $ proxy)", () => {
		const result = V2RegularStepSchema.parse({
			...baseStep,
			idempotencyKey: "js/ctx.req.body.requestId",
		});
		expect(result.idempotencyKey).toBe("js/ctx.req.body.requestId");
	});

	it("rejects an empty idempotencyKey string", () => {
		expect(() => V2RegularStepSchema.parse({ ...baseStep, idempotencyKey: "" })).toThrow();
	});

	it("rejects a non-string idempotencyKey", () => {
		expect(() =>
			V2RegularStepSchema.parse({
				...baseStep,
				idempotencyKey: 42 as unknown as string,
			}),
		).toThrow();
	});

	it("accepts an integer idempotencyKeyTTL in milliseconds", () => {
		const result = V2RegularStepSchema.parse({
			...baseStep,
			idempotencyKey: "k",
			idempotencyKeyTTL: 60_000,
		});
		expect(result.idempotencyKeyTTL).toBe(60_000);
	});

	it("accepts idempotencyKeyTTL of 0 (immediately expired)", () => {
		const result = V2RegularStepSchema.parse({
			...baseStep,
			idempotencyKey: "k",
			idempotencyKeyTTL: 0,
		});
		expect(result.idempotencyKeyTTL).toBe(0);
	});

	it("rejects negative idempotencyKeyTTL", () => {
		expect(() =>
			V2RegularStepSchema.parse({
				...baseStep,
				idempotencyKey: "k",
				idempotencyKeyTTL: -1,
			}),
		).toThrow();
	});

	it("rejects non-integer idempotencyKeyTTL", () => {
		expect(() =>
			V2RegularStepSchema.parse({
				...baseStep,
				idempotencyKey: "k",
				idempotencyKeyTTL: 1.5,
			}),
		).toThrow();
	});

	it("accepts a minimal retry config (maxAttempts only)", () => {
		const result = V2RegularStepSchema.parse({ ...baseStep, retry: { maxAttempts: 3 } });
		expect(result.retry?.maxAttempts).toBe(3);
		expect(result.retry?.minTimeoutInMs).toBeUndefined();
		expect(result.retry?.factor).toBeUndefined();
	});

	it("accepts a full retry config", () => {
		const result = V2RegularStepSchema.parse({
			...baseStep,
			retry: { maxAttempts: 5, minTimeoutInMs: 500, maxTimeoutInMs: 10_000, factor: 2 },
		});
		expect(result.retry?.maxAttempts).toBe(5);
		expect(result.retry?.minTimeoutInMs).toBe(500);
		expect(result.retry?.maxTimeoutInMs).toBe(10_000);
		expect(result.retry?.factor).toBe(2);
	});
});

describe("RetryConfigSchema", () => {
	it("requires maxAttempts", () => {
		expect(() => RetryConfigSchema.parse({} as unknown as { maxAttempts: number })).toThrow();
	});

	it("rejects maxAttempts < 1", () => {
		expect(() => RetryConfigSchema.parse({ maxAttempts: 0 })).toThrow();
	});

	it("rejects maxAttempts > 20", () => {
		expect(() => RetryConfigSchema.parse({ maxAttempts: 21 })).toThrow();
	});

	it("rejects non-integer maxAttempts", () => {
		expect(() => RetryConfigSchema.parse({ maxAttempts: 1.5 })).toThrow();
	});

	it("rejects factor < 1", () => {
		expect(() => RetryConfigSchema.parse({ maxAttempts: 3, factor: 0.5 })).toThrow();
	});

	it("accepts factor === 1 (constant backoff)", () => {
		const result = RetryConfigSchema.parse({ maxAttempts: 3, factor: 1 });
		expect(result.factor).toBe(1);
	});

	it("rejects negative timeouts", () => {
		expect(() => RetryConfigSchema.parse({ maxAttempts: 3, minTimeoutInMs: -1 })).toThrow();
		expect(() => RetryConfigSchema.parse({ maxAttempts: 3, maxTimeoutInMs: -1 })).toThrow();
	});

	it("rejects minTimeoutInMs > maxTimeoutInMs", () => {
		expect(() => RetryConfigSchema.parse({ maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 1000 })).toThrow(
			/maxTimeoutInMs/,
		);
	});

	it("accepts minTimeoutInMs === maxTimeoutInMs (capped at first delay)", () => {
		const result = RetryConfigSchema.parse({ maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 1000 });
		expect(result.minTimeoutInMs).toBe(1000);
		expect(result.maxTimeoutInMs).toBe(1000);
	});
});

describe("V2SubworkflowStepSchema", () => {
	const baseStep = { id: "call-child", subworkflow: "send-receipt" };

	it("accepts the minimal shape (id + subworkflow)", () => {
		const result = V2SubworkflowStepSchema.parse(baseStep);
		expect(result.id).toBe("call-child");
		expect(result.subworkflow).toBe("send-receipt");
	});

	it("requires a non-empty id", () => {
		expect(() => V2SubworkflowStepSchema.parse({ subworkflow: "x" })).toThrow();
		expect(() => V2SubworkflowStepSchema.parse({ id: "", subworkflow: "x" })).toThrow();
	});

	it("requires a non-empty subworkflow name", () => {
		expect(() => V2SubworkflowStepSchema.parse({ id: "x" })).toThrow();
		expect(() => V2SubworkflowStepSchema.parse({ id: "x", subworkflow: "" })).toThrow();
	});

	it("accepts inputs as an arbitrary record", () => {
		const result = V2SubworkflowStepSchema.parse({
			...baseStep,
			inputs: { user: { id: 1 }, total: 99.99 },
		});
		expect(result.inputs).toEqual({ user: { id: 1 }, total: 99.99 });
	});

	it("accepts wait: true explicitly", () => {
		const result = V2SubworkflowStepSchema.parse({ ...baseStep, wait: true });
		expect(result.wait).toBe(true);
	});

	it("rejects wait: false with a clear deferred-feature message", () => {
		expect(() => V2SubworkflowStepSchema.parse({ ...baseStep, wait: false })).toThrow(/wait: false.*not yet supported/);
	});

	it("rejects as + spread combo (mutually exclusive)", () => {
		expect(() => V2SubworkflowStepSchema.parse({ ...baseStep, as: "out", spread: true })).toThrow(/mutually exclusive/);
	});

	it("threads idempotencyKey + idempotencyKeyTTL", () => {
		const result = V2SubworkflowStepSchema.parse({
			...baseStep,
			idempotencyKey: "req-123",
			idempotencyKeyTTL: 60_000,
		});
		expect(result.idempotencyKey).toBe("req-123");
		expect(result.idempotencyKeyTTL).toBe(60_000);
	});

	it("threads a retry config", () => {
		const result = V2SubworkflowStepSchema.parse({
			...baseStep,
			retry: { maxAttempts: 3, minTimeoutInMs: 500, factor: 2 },
		});
		expect(result.retry?.maxAttempts).toBe(3);
		expect(result.retry?.minTimeoutInMs).toBe(500);
	});

	it("accepts active/stop/ephemeral/as flags", () => {
		const result = V2SubworkflowStepSchema.parse({
			...baseStep,
			active: false,
			stop: true,
			ephemeral: true,
		});
		expect(result.active).toBe(false);
		expect(result.stop).toBe(true);
		expect(result.ephemeral).toBe(true);
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
