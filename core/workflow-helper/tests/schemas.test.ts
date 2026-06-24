import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
	NodeTypeSchema,
	RetryConfigSchema,
	RuntimeKindSchema,
	StepOptsSchema,
	V2BranchStepSchema,
	V2ForEachStepSchema,
	V2LoopStepSchema,
	V2RegularStepSchema,
	V2StepSchema,
	V2SubworkflowStepSchema,
	V2SwitchStepSchema,
	V2TryCatchStepSchema,
	V2WaitStepSchema,
	isWaitStep,
} from "../src/types/StepOpts";
import {
	ConcurrencyOptsSchema,
	CronTriggerOptsSchema,
	DebounceOptsSchema,
	HttpTriggerOptsSchema,
	QueueTriggerOptsSchema,
	SchedulingOptsSchema,
	TRIGGER_SCHEMAS,
	TriggersSchema,
	WebhookTriggerOptsSchema,
	WorkerTriggerOptsSchema,
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

	it("should allow optional active, stop", () => {
		const result = StepOptsSchema.parse({
			name: "step",
			node: "my-node-name",
			type: "module",
			active: false,
			stop: true,
		});
		expect(result.active).toBe(false);
		expect(result.stop).toBe(true);
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

	it("accepts wait: false (fire-and-forget — Tier 2 #4 follow-up)", () => {
		const result = V2SubworkflowStepSchema.parse({ ...baseStep, wait: false });
		expect(result.wait).toBe(false);
	});

	it("accepts wait: false combined with idempotencyKey (at-most-once dispatch)", () => {
		const result = V2SubworkflowStepSchema.parse({
			...baseStep,
			wait: false,
			idempotencyKey: "request-123",
		}) as { wait: boolean; idempotencyKey: string };
		expect(result.wait).toBe(false);
		expect(result.idempotencyKey).toBe("request-123");
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

// =============================================================================
// F9 — step schema strictness. Misplaced trigger fields and typo'd step fields
// must be REJECTED (not silently stripped), while every legitimate field still
// passes.
// =============================================================================

describe("F9 — V2RegularStepSchema strictness", () => {
	const baseStep = { id: "fetch", use: "@blokjs/api-call" };

	it("still accepts every legitimate regular-step field", () => {
		expect(() =>
			V2RegularStepSchema.parse({
				...baseStep,
				type: "module",
				inputs: { url: "https://example.com" },
				as: "result",
				ephemeral: false,
				runtime: "nodejs",
				active: true,
				stop: false,
				stream_logs: true,
				streamTo: "sse",
				stream: true,
				idempotencyKey: "k",
				idempotencyKeyTTL: 1000,
				retry: { maxAttempts: 3 },
				maxDuration: "30s",
			}),
		).not.toThrow();
	});

	it("rejects a typo'd field (`retr` instead of `retry`)", () => {
		expect(() => V2RegularStepSchema.parse({ ...baseStep, retr: { maxAttempts: 3 } })).toThrow(/[Uu]nrecognized key/);
	});

	it("rejects a typo'd `idempotencyKey` (`idempotencykey`)", () => {
		expect(() => V2RegularStepSchema.parse({ ...baseStep, idempotencykey: "x" })).toThrow(/[Uu]nrecognized key/);
	});

	it("rejects a misplaced trigger field (`concurrencyKey`) with a trigger-config hint", () => {
		expect(() => V2RegularStepSchema.parse({ ...baseStep, concurrencyKey: "tenant-1" })).toThrow(
			/trigger-level field/i,
		);
	});

	it("rejects misplaced scheduling fields (`delay` / `ttl` / `debounce`) with a trigger-config hint", () => {
		expect(() => V2RegularStepSchema.parse({ ...baseStep, delay: "1h" })).toThrow(/trigger-level field/i);
		expect(() => V2RegularStepSchema.parse({ ...baseStep, ttl: "2h" })).toThrow(/trigger-level field/i);
		expect(() => V2RegularStepSchema.parse({ ...baseStep, debounce: { key: "k", delay: 500 } })).toThrow(
			/trigger-level field/i,
		);
	});

	it("rejects a step carrying BOTH a misplaced trigger field AND a typo", () => {
		// The canonical silent-miscompile case from the F9 spec.
		expect(() => V2RegularStepSchema.parse({ ...baseStep, concurrencyKey: "t", retr: { maxAttempts: 3 } })).toThrow();
	});
});

describe("F9 — control-flow step schema strictness", () => {
	it("branch: rejects an unknown top-level key", () => {
		expect(() =>
			V2BranchStepSchema.parse({ id: "b", branch: { when: "true", then: [] }, retry: { maxAttempts: 2 } }),
		).toThrow(/[Uu]nrecognized key/);
	});

	it("branch: rejects an unknown key inside the `branch` block", () => {
		expect(() => V2BranchStepSchema.parse({ id: "b", branch: { when: "true", then: [], elze: [] } })).toThrow(
			/[Uu]nrecognized key/,
		);
	});

	it("branch: still accepts the legitimate shape", () => {
		expect(() =>
			V2BranchStepSchema.parse({ id: "b", branch: { when: "true", then: [], else: [] }, active: true, stop: false }),
		).not.toThrow();
	});

	it("forEach: rejects an unknown top-level key", () => {
		expect(() =>
			V2ForEachStepSchema.parse({
				id: "fe",
				forEach: { in: "$.state.items", as: "item", do: [{ id: "x", use: "n" }] },
				bogus: true,
			}),
		).toThrow(/[Uu]nrecognized key/);
	});

	it("forEach: still accepts the legitimate shape", () => {
		expect(() =>
			V2ForEachStepSchema.parse({
				id: "fe",
				forEach: { in: "$.state.items", as: "item", mode: "parallel", concurrency: 5, do: [{ id: "x", use: "n" }] },
			}),
		).not.toThrow();
	});

	it("loop: rejects an unknown top-level key", () => {
		expect(() =>
			V2LoopStepSchema.parse({ id: "lp", loop: { while: "true", do: [{ id: "x", use: "n" }] }, retry: {} }),
		).toThrow(/[Uu]nrecognized key/);
	});

	it("switch: rejects an unknown key inside a case", () => {
		expect(() =>
			V2SwitchStepSchema.parse({
				id: "sw",
				switch: { on: "$.x", cases: [{ when: "a", do: [{ id: "x", use: "n" }], bogus: 1 }] },
			}),
		).toThrow(/[Uu]nrecognized key/);
	});

	it("switch: still accepts the legitimate shape", () => {
		expect(() =>
			V2SwitchStepSchema.parse({
				id: "sw",
				switch: { on: "$.x", cases: [{ when: "a", do: [{ id: "x", use: "n" }] }], default: [{ id: "d", use: "n" }] },
			}),
		).not.toThrow();
	});

	it("tryCatch: rejects an unknown top-level key", () => {
		expect(() =>
			V2TryCatchStepSchema.parse({
				id: "tc",
				tryCatch: { try: [{ id: "x", use: "n" }], catch: [{ id: "y", use: "n" }] },
				ephemeral: true,
			}),
		).toThrow(/[Uu]nrecognized key/);
	});

	it("tryCatch: still accepts the legitimate shape", () => {
		expect(() =>
			V2TryCatchStepSchema.parse({
				id: "tc",
				tryCatch: {
					try: [{ id: "x", use: "n" }],
					catch: [{ id: "y", use: "n" }],
					finally: [{ id: "z", use: "n" }],
				},
			}),
		).not.toThrow();
	});

	it("subworkflow: rejects an unknown top-level key", () => {
		expect(() => V2SubworkflowStepSchema.parse({ id: "sw", subworkflow: "child", bogus: 1 })).toThrow(
			/[Uu]nrecognized key/,
		);
	});
});

// =============================================================================
// F22 — V2StepSchema dispatches to one member schema by key presence, so a
// malformed control-flow step gets THAT member's error verbatim instead of a
// noisy multi-arm `invalid_union` that also blames the regular-step `use`.
// =============================================================================

describe("F22 — V2StepSchema single-member error discrimination", () => {
	it("a branch missing `when` reports the branch error, NOT `use is required`", () => {
		const result = V2StepSchema.safeParse({ id: "route", branch: { then: [] } });
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = result.error.message;
			// The error must point at branch.when ...
			expect(msg).toMatch(/when/i);
			// ... and must NOT mention the regular-step `use` field (the old
			// z.union behavior aggregated that misleading message).
			expect(msg).not.toMatch(/`use` is required/i);
			// No invalid_union aggregation either.
			expect(result.error.issues.some((iss) => iss.code === "invalid_union")).toBe(false);
		}
	});

	it("a valid branch step parses through V2StepSchema", () => {
		const result = V2StepSchema.safeParse({ id: "route", branch: { when: "true", then: [], else: [] } });
		expect(result.success).toBe(true);
	});

	it("a valid regular step parses through V2StepSchema", () => {
		const result = V2StepSchema.safeParse({ id: "fetch", use: "@blokjs/api-call" });
		expect(result.success).toBe(true);
	});

	it("a regular step missing `use` reports the regular-step error (no control-flow noise)", () => {
		const result = V2StepSchema.safeParse({ id: "fetch" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).toMatch(/use/i);
			expect(result.error.issues.some((iss) => iss.code === "invalid_union")).toBe(false);
		}
	});

	it("a malformed subworkflow step reports the subworkflow error, not `use is required`", () => {
		const result = V2StepSchema.safeParse({ id: "call", subworkflow: "" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).not.toMatch(/`use` is required/i);
		}
	});

	it("a forEach missing its `as` reports the forEach error, not `use is required`", () => {
		const result = V2StepSchema.safeParse({ id: "fe", forEach: { in: "$.x", do: [{ id: "x", use: "n" }] } });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).not.toMatch(/`use` is required/i);
		}
	});

	it("a malformed wait step reports the wait error, not `use is required` (dispatch by `wait`)", () => {
		// `wait` present but empty → wait member's "for/until mutually exclusive"
		// refinement, NOT the regular-step `use` error.
		const result = V2StepSchema.safeParse({ id: "w", wait: {} });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).not.toMatch(/`use` is required/i);
			expect(result.error.issues.some((iss) => iss.code === "invalid_union")).toBe(false);
		}
	});

	it("a malformed switch step reports the switch error, not `use is required` (dispatch by `switch`)", () => {
		const result = V2StepSchema.safeParse({ id: "sw", switch: { on: "$.x", cases: [] } });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).not.toMatch(/`use` is required/i);
			expect(result.error.issues.some((iss) => iss.code === "invalid_union")).toBe(false);
		}
	});

	it("dispatches a misplaced trigger field on a regular step to the F9 trigger-level hint", () => {
		// A regular step (no control-flow key) carrying a trigger-only field must
		// surface the F9 hint, NOT a noisy invalid_union, confirming F9 + F22
		// compose through the single-member dispatch.
		const result = V2StepSchema.safeParse({ id: "f", use: "n", concurrencyKey: "tenant-1" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.message).toMatch(/trigger-level field/i);
			expect(result.error.issues.some((iss) => iss.code === "invalid_union")).toBe(false);
		}
	});

	it("accepts every control-flow step shape through V2StepSchema (dispatch coverage)", () => {
		const shapes: unknown[] = [
			{ id: "r", use: "@blokjs/api-call" },
			{ id: "b", branch: { when: "true", then: [{ id: "x", use: "n" }] } },
			{ id: "s", subworkflow: "child" },
			{ id: "w", wait: { for: "1h" } },
			{ id: "fe", forEach: { in: "$.x", as: "item", do: [{ id: "x", use: "n" }] } },
			{ id: "lp", loop: { while: "true", do: [{ id: "x", use: "n" }] } },
			{ id: "sw", switch: { on: "$.x", cases: [{ when: "a", do: [{ id: "x", use: "n" }] }] } },
			{ id: "tc", tryCatch: { try: [{ id: "x", use: "n" }], catch: [{ id: "y", use: "n" }] } },
		];
		for (const shape of shapes) {
			expect(V2StepSchema.safeParse(shape).success).toBe(true);
		}
	});

	// Regression guard: V2StepSchema feeds `WorkflowV2Schema.steps`, which
	// `scripts/build-schema.ts` runs through `zodToJsonSchema` to publish the
	// JSON Schema the VS Code extension consumes for `.json`-workflow
	// autocomplete + inline docs. An earlier F22 attempt used
	// `z.unknown().transform(...)`, which renders to `{}` (no structure → no
	// autocomplete), silently gutting that tooling. The schema MUST still emit
	// an `anyOf` carrying the concrete per-step-type member shapes.
	it("renders an anyOf of the per-step-type member shapes for editor tooling", () => {
		const json = zodToJsonSchema(V2StepSchema, { target: "jsonSchema7", $refStrategy: "none" }) as {
			anyOf?: Array<{ properties?: Record<string, unknown> }>;
		};
		expect(Array.isArray(json.anyOf)).toBe(true);
		const members = json.anyOf ?? [];
		// The eight concrete step shapes must each be present as a structured
		// object member (discriminated by their control-flow key, or `use` for
		// the regular step). The catch-all permissive arm may add one more.
		const discriminators = new Set<string>();
		for (const m of members) {
			if (!m.properties) continue;
			for (const key of ["branch", "subworkflow", "wait", "forEach", "loop", "switch", "tryCatch", "use"]) {
				if (key in m.properties) discriminators.add(key);
			}
		}
		for (const key of ["branch", "subworkflow", "wait", "forEach", "loop", "switch", "tryCatch", "use"]) {
			expect(discriminators.has(key)).toBe(true);
		}
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

	it("accepts concurrencyKey + concurrencyLimit (Tier 2 #6)", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "tenant-abc",
				concurrencyLimit: 5,
			}),
		).not.toThrow();
	});

	it("accepts concurrencyKey alone (limit defaults at runtime to 1)", () => {
		const result = HttpTriggerOptsSchema.parse({
			method: "POST",
			concurrencyKey: "tenant-abc",
		}) as { concurrencyKey: string; concurrencyLimit?: number };
		expect(result.concurrencyKey).toBe("tenant-abc");
		expect(result.concurrencyLimit).toBeUndefined();
	});

	it("accepts a $-proxy compiled string for concurrencyKey", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "js/ctx.request.body.userId",
				concurrencyLimit: 3,
			}),
		).not.toThrow();
	});

	it("rejects empty-string concurrencyKey", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "",
			}),
		).toThrow();
	});

	it("rejects concurrencyLimit < 1", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "x",
				concurrencyLimit: 0,
			}),
		).toThrow();
	});

	it("rejects non-integer concurrencyLimit", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "x",
				concurrencyLimit: 2.5,
			}),
		).toThrow();
	});

	it("rejects concurrencyLimit set without concurrencyKey", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyLimit: 5,
			}),
		).toThrow(/concurrencyLimit.+requires.+concurrencyKey/i);
	});

	it("rejects concurrencyLeaseMs set without concurrencyKey", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyLeaseMs: 60_000,
			}),
		).toThrow(/concurrencyLeaseMs.+requires.+concurrencyKey/i);
	});

	it("rejects concurrencyLeaseMs below 1s", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "x",
				concurrencyLeaseMs: 500,
			}),
		).toThrow();
	});

	it("accepts concurrencyLeaseMs >= 1s", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				concurrencyKey: "x",
				concurrencyLeaseMs: 1_000,
			}),
		).not.toThrow();
	});

	it("accepts onLimit: 'queue' with concurrencyKey", () => {
		const result = HttpTriggerOptsSchema.parse({
			method: "POST",
			concurrencyKey: "tenant-q",
			onLimit: "queue",
		}) as { onLimit?: "throw" | "queue" };
		expect(result.onLimit).toBe("queue");
	});

	it("accepts onLimit: 'throw' explicitly", () => {
		const result = HttpTriggerOptsSchema.parse({
			method: "POST",
			concurrencyKey: "tenant-t",
			onLimit: "throw",
		}) as { onLimit?: "throw" | "queue" };
		expect(result.onLimit).toBe("throw");
	});

	it("rejects onLimit set without concurrencyKey", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				onLimit: "queue",
			}),
		).toThrow(/onLimit.+requires.+concurrencyKey/i);
	});
});

describe("WorkerTriggerOptsSchema concurrency keys", () => {
	it("accepts concurrencyKey + concurrencyLimit alongside legacy concurrency", () => {
		const result = WorkerTriggerOptsSchema.parse({
			queue: "renders",
			concurrency: 10,
			concurrencyKey: "$.req.body.tenantId",
			concurrencyLimit: 2,
		}) as {
			queue: string;
			concurrency: number;
			concurrencyKey?: string;
			concurrencyLimit?: number;
		};
		expect(result.concurrency).toBe(10);
		expect(result.concurrencyKey).toBe("$.req.body.tenantId");
		expect(result.concurrencyLimit).toBe(2);
	});

	it("rejects concurrencyLimit without concurrencyKey on worker triggers too", () => {
		expect(() =>
			WorkerTriggerOptsSchema.parse({
				queue: "renders",
				concurrencyLimit: 2,
			}),
		).toThrow(/concurrencyLimit.+requires.+concurrencyKey/i);
	});

	it("default consumer concurrency stays 1 when only concurrencyKey provided", () => {
		const result = WorkerTriggerOptsSchema.parse({
			queue: "renders",
			concurrencyKey: "x",
		}) as { concurrency: number };
		expect(result.concurrency).toBe(1);
	});
});

describe("ConcurrencyOptsSchema (standalone)", () => {
	it("accepts an empty object (all fields optional)", () => {
		expect(() => ConcurrencyOptsSchema.parse({})).not.toThrow();
	});

	it("accepts a key alone", () => {
		expect(() => ConcurrencyOptsSchema.parse({ concurrencyKey: "k" })).not.toThrow();
	});

	it("rejects limit without key", () => {
		expect(() => ConcurrencyOptsSchema.parse({ concurrencyLimit: 5 })).toThrow();
	});

	it("rejects leaseMs without key", () => {
		expect(() => ConcurrencyOptsSchema.parse({ concurrencyLeaseMs: 60_000 })).toThrow();
	});
});

// =============================================================================
// Tier 2 #5 + #7 — Scheduling: delay / TTL / debounce
// =============================================================================

describe("DebounceOptsSchema", () => {
	it("accepts the minimal shape with defaults", () => {
		const result = DebounceOptsSchema.parse({ key: "doc-1", delay: "500ms" });
		expect(result.key).toBe("doc-1");
		expect(result.mode).toBe("trailing");
		expect(result.delay).toBe("500ms");
	});

	it("accepts numeric delay", () => {
		expect(() => DebounceOptsSchema.parse({ key: "k", delay: 500 })).not.toThrow();
	});

	it('accepts mode "leading"', () => {
		const result = DebounceOptsSchema.parse({ key: "k", mode: "leading", delay: 100 });
		expect(result.mode).toBe("leading");
	});

	it("accepts maxDelay >= delay (numbers)", () => {
		expect(() => DebounceOptsSchema.parse({ key: "k", delay: 500, maxDelay: 5000 })).not.toThrow();
	});

	it("rejects maxDelay < delay (numbers)", () => {
		expect(() => DebounceOptsSchema.parse({ key: "k", delay: 5000, maxDelay: 500 })).toThrow(/maxDelay.+>=.+delay/i);
	});

	it("does not enforce maxDelay/delay relationship at the schema layer when string units differ", () => {
		// Schema-layer relaxation — runtime parseDuration normalizes.
		expect(() => DebounceOptsSchema.parse({ key: "k", delay: "5s", maxDelay: "1m" })).not.toThrow();
	});

	it("rejects empty key", () => {
		expect(() => DebounceOptsSchema.parse({ key: "", delay: 500 })).toThrow();
	});

	it("rejects bad mode", () => {
		expect(() => DebounceOptsSchema.parse({ key: "k", mode: "throttle" as never, delay: 500 })).toThrow();
	});

	it("rejects malformed delay strings", () => {
		expect(() => DebounceOptsSchema.parse({ key: "k", delay: "1h30m" })).toThrow();
		expect(() => DebounceOptsSchema.parse({ key: "k", delay: "garbage" })).toThrow();
	});
});

describe("SchedulingOptsSchema (standalone)", () => {
	it("accepts an empty object (all fields optional)", () => {
		expect(() => SchedulingOptsSchema.parse({})).not.toThrow();
	});

	it("accepts delay as number or duration string", () => {
		expect(() => SchedulingOptsSchema.parse({ delay: 1000 })).not.toThrow();
		expect(() => SchedulingOptsSchema.parse({ delay: "1h" })).not.toThrow();
		expect(() => SchedulingOptsSchema.parse({ delay: "30m" })).not.toThrow();
		expect(() => SchedulingOptsSchema.parse({ delay: "500ms" })).not.toThrow();
		expect(() => SchedulingOptsSchema.parse({ delay: "1d" })).not.toThrow();
	});

	it("rejects malformed duration strings", () => {
		expect(() => SchedulingOptsSchema.parse({ delay: "1h30m" })).toThrow();
		expect(() => SchedulingOptsSchema.parse({ delay: "1.5h" })).toThrow();
		expect(() => SchedulingOptsSchema.parse({ delay: "abc" })).toThrow();
	});

	it("rejects negative numeric delay", () => {
		expect(() => SchedulingOptsSchema.parse({ delay: -1 })).toThrow();
	});

	it("accepts ttl with same surface as delay", () => {
		expect(() => SchedulingOptsSchema.parse({ ttl: "2h" })).not.toThrow();
		expect(() => SchedulingOptsSchema.parse({ ttl: 60_000 })).not.toThrow();
	});

	it("accepts debounce nested under scheduling", () => {
		expect(() =>
			SchedulingOptsSchema.parse({
				debounce: { key: "doc-1", delay: "500ms", maxDelay: "5s" },
			}),
		).not.toThrow();
	});

	it("does NOT enforce HTTP-specific ttl-without-delay rule (that's per-trigger)", () => {
		// Standalone schema permissive; per-trigger refinement enforces the rule.
		expect(() => SchedulingOptsSchema.parse({ ttl: "2h" })).not.toThrow();
	});
});

describe("HttpTriggerOptsSchema scheduling fields", () => {
	it("accepts delay (number)", () => {
		expect(() => HttpTriggerOptsSchema.parse({ method: "POST", delay: 5000 })).not.toThrow();
	});

	it("accepts delay (duration string)", () => {
		expect(() => HttpTriggerOptsSchema.parse({ method: "POST", delay: "1h" })).not.toThrow();
	});

	it("accepts delay + ttl together", () => {
		expect(() => HttpTriggerOptsSchema.parse({ method: "POST", delay: "1h", ttl: "2h" })).not.toThrow();
	});

	it("rejects ttl WITHOUT delay (HTTP-only rule)", () => {
		expect(() => HttpTriggerOptsSchema.parse({ method: "POST", ttl: "2h" })).toThrow(/HTTP.+ttl.+requires.+delay/i);
	});

	it("accepts debounce alone", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				debounce: { key: "$.req.body.docId", delay: "500ms", maxDelay: "5s" },
			}),
		).not.toThrow();
	});

	it("accepts debounce + concurrency together", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				debounce: { key: "doc", delay: 500 },
				concurrencyKey: "tenant-x",
				concurrencyLimit: 3,
			}),
		).not.toThrow();
	});

	it("accepts a $-proxy compiled string for debounce.key", () => {
		expect(() =>
			HttpTriggerOptsSchema.parse({
				method: "POST",
				debounce: { key: "js/ctx.request.body.userId", delay: 1000 },
			}),
		).not.toThrow();
	});
});

describe("WorkerTriggerOptsSchema scheduling fields", () => {
	it("accepts delay as a number (back-compat)", () => {
		const result = WorkerTriggerOptsSchema.parse({
			queue: "q",
			delay: 60_000,
		}) as { delay: number | string };
		expect(result.delay).toBe(60_000);
	});

	it("accepts delay as a duration string (Tier 2 #5)", () => {
		const result = WorkerTriggerOptsSchema.parse({
			queue: "q",
			delay: "1h",
		}) as { delay: number | string };
		expect(result.delay).toBe("1h");
	});

	it("accepts ttl WITHOUT delay (worker-specific rule)", () => {
		// Worker queue-time TTL is independent of delay.
		expect(() => WorkerTriggerOptsSchema.parse({ queue: "q", ttl: "1h" })).not.toThrow();
	});

	it("accepts debounce + concurrency stacked (orthogonal gates)", () => {
		expect(() =>
			WorkerTriggerOptsSchema.parse({
				queue: "q",
				concurrency: 10,
				concurrencyKey: "tenant",
				concurrencyLimit: 2,
				debounce: { key: "$.req.body.docId", delay: 500, maxDelay: 5000 },
				delay: "5s",
				ttl: "30m",
			}),
		).not.toThrow();
	});

	it("rejects malformed delay strings", () => {
		expect(() => WorkerTriggerOptsSchema.parse({ queue: "q", delay: "1.5h" })).toThrow();
	});
});

// F10 — the QueueTriggerOptsSchema object is intentionally KEPT (it stays
// exported as `QueueTriggerOpts`/`QueueTriggerOptsSchema` for back-compat and
// type consumers, and remains in TRIGGER_SCHEMAS so the registry exhaustiveness
// check holds). Only `validateTriggerConfig` (the construction layer) rejects
// the `queue` kind — see the validateTriggerConfig block below. The schema
// shape itself still parses in isolation.
describe("QueueTriggerOptsSchema", () => {
	it("should validate queue trigger options (schema shape kept for back-compat)", () => {
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
	it("should validate a v0.7 built-in provider config", () => {
		const result = WebhookTriggerOptsSchema.parse({
			provider: "github",
			path: "/webhooks/github",
			secretEnv: "GITHUB_WEBHOOK_SECRET",
			events: ["push", "pull_request"],
		});
		expect(result.provider).toBe("github");
		expect(result.events).toEqual(["push", "pull_request"]);
		expect(result.secretEnv).toBe("GITHUB_WEBHOOK_SECRET");
	});

	it("should validate a custom signature config (unknown provider)", () => {
		const result = WebhookTriggerOptsSchema.parse({
			path: "/webhooks/acme",
			signature: {
				header: "X-Acme-Signature",
				secretEnv: "ACME_SECRET",
				timestampHeader: "X-Acme-Timestamp",
			},
		});
		expect(result.signature?.header).toBe("X-Acme-Signature");
		expect(result.signature?.scheme).toBe("hmac-sha256");
		expect(result.signature?.tolerance).toBe(300);
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

// PR 4 P1 — wait step schema.
describe("V2WaitStepSchema (PR 4 wait.for / wait.until)", () => {
	it("accepts { id, wait: { for } } with a duration string", () => {
		const result = V2WaitStepSchema.parse({ id: "wait-3d", wait: { for: "3d" } });
		expect(result.id).toBe("wait-3d");
		expect(result.wait.for).toBe("3d");
	});

	it("accepts { id, wait: { for } } with a numeric millisecond value", () => {
		const result = V2WaitStepSchema.parse({ id: "wait-ms", wait: { for: 60_000 } });
		expect(result.wait.for).toBe(60_000);
	});

	it("accepts { id, wait: { until } } with a numeric ms-since-epoch", () => {
		const result = V2WaitStepSchema.parse({ id: "wait-deadline", wait: { until: 1735741200000 } });
		expect(result.wait.until).toBe(1735741200000);
	});

	it("accepts { id, wait: { until } } with a string (ISO date or $-proxy expression)", () => {
		const result = V2WaitStepSchema.parse({ id: "wait-iso", wait: { until: "2026-12-31T00:00:00Z" } });
		expect(result.wait.until).toBe("2026-12-31T00:00:00Z");
	});

	it("rejects when both `for` and `until` are set", () => {
		expect(() => V2WaitStepSchema.parse({ id: "x", wait: { for: "1h", until: 0 } })).toThrow(/mutually exclusive/i);
	});

	it("rejects when neither `for` nor `until` is set", () => {
		expect(() => V2WaitStepSchema.parse({ id: "x", wait: {} })).toThrow();
	});

	it("requires a non-empty id", () => {
		expect(() => V2WaitStepSchema.parse({ id: "", wait: { for: "1h" } })).toThrow();
		expect(() => V2WaitStepSchema.parse({ wait: { for: "1h" } })).toThrow();
	});

	it("accepts optional as / ephemeral / active / stop", () => {
		const result = V2WaitStepSchema.parse({
			id: "x",
			wait: { for: "30s" },
			as: "waitMarker",
			ephemeral: true,
			active: false,
			stop: true,
		});
		expect(result.as).toBe("waitMarker");
		expect(result.ephemeral).toBe(true);
		expect(result.active).toBe(false);
		expect(result.stop).toBe(true);
	});

	it("isWaitStep returns true for wait shapes and false for others", () => {
		const wait = { id: "x", wait: { for: "1h" } };
		expect(isWaitStep(wait as never)).toBe(true);
		expect(isWaitStep({ id: "x", use: "node-x" } as never)).toBe(false);
		expect(isWaitStep({ id: "x", subworkflow: "y" } as never)).toBe(false);
		expect(isWaitStep({ id: "x", branch: { when: "true", then: [] } } as never)).toBe(false);
	});

	// PR 1-5 polish — explicit refinements for idempotencyKey + retry produce
	// helpful error messages rather than the generic "Unrecognized key(s) in
	// object" that .strict() emits on its own. Authors should know WHY the
	// field was rejected, not just that it's unknown.
	it("rejects `idempotencyKey` with a helpful message about checkpoint semantics", () => {
		expect(() =>
			V2WaitStepSchema.parse({ id: "x", wait: { for: "1h" }, idempotencyKey: "k" } as unknown as never),
		).toThrow(/wait IS the checkpoint|idempotencyKey.*not supported on wait/i);
	});

	it("rejects `retry` with a helpful message about non-retryable waits", () => {
		expect(() =>
			V2WaitStepSchema.parse({
				id: "x",
				wait: { for: "1h" },
				retry: { maxAttempts: 3 },
			} as unknown as never),
		).toThrow(/retryable way|retry.*not supported on wait/i);
	});

	// Review fix-up — three more rejections that the original polish PR
	// missed. Each has a feature-specific helpful message instead of the
	// generic "Unrecognized key in object" that .strict() emits.
	it("rejects `maxDuration` with a helpful message", () => {
		expect(() =>
			V2WaitStepSchema.parse({ id: "x", wait: { for: "1h" }, maxDuration: "30s" } as unknown as never),
		).toThrow(/wait IS the duration|maxDuration.*not supported on wait/i);
	});

	it("rejects `concurrencyKey` with a helpful message about trigger-config scope", () => {
		expect(() =>
			V2WaitStepSchema.parse({ id: "x", wait: { for: "1h" }, concurrencyKey: "k" } as unknown as never),
		).toThrow(/trigger config|concurrencyKey.*not supported on wait/i);
	});

	it("rejects `spread` with a helpful message about no-data-to-spread", () => {
		expect(() => V2WaitStepSchema.parse({ id: "x", wait: { for: "1h" }, spread: true } as unknown as never)).toThrow(
			/no data to spread|spread.*not supported on wait/i,
		);
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
		expect(() => validateTriggerConfig("worker", undefined)).toThrow(/requires a configuration object/);
	});

	// F10 — `queue` is a dead trigger kind: validated by the DSL but consumed
	// by no runtime. validateTriggerConfig rejects it BEFORE the config shape
	// check (so even a well-formed queue config fails) and points to `worker`.
	it('rejects the dead "queue" trigger kind and points to "worker"', () => {
		expect(() => validateTriggerConfig("queue", undefined)).toThrow(/no runtime.+use "worker"/i);
		expect(() => validateTriggerConfig("queue", { provider: "kafka", topic: "events" })).toThrow(
			/no runtime.+use "worker"/i,
		);
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
		expect(() => validateTriggerConfig("worker", { queue: 123 })).toThrow();
	});
});
