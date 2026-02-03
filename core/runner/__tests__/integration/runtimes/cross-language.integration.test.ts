import type { Context } from "@blokjs/shared";
/**
 * Cross-Language Integration Tests (Phase 5G)
 *
 * Validates that all 11 RuntimeKinds can be registered, routed, and composed
 * into polyglot workflows. Uses MockRuntimeAdapter to simulate real runtimes
 * without requiring Docker containers or external processes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RunnerNode from "../../../src/RunnerNode";
import { RuntimeAdapterNode } from "../../../src/RuntimeAdapterNode";
import { RuntimeRegistry } from "../../../src/RuntimeRegistry";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "../../../src/adapters/RuntimeAdapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(vars: Record<string, unknown> = {}): Context {
	return {
		id: `cross-lang-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		workflow_name: "cross-language-test",
		workflow_path: "/cross-language-test",
		config: {},
		request: { body: {} },
		response: { data: "", contentType: "", success: true, error: null },
		error: { message: [] },
		vars,
		logger: console as any,
		eventLogger: null,
		_PRIVATE_: null,
		env: process.env,
	} as unknown as Context;
}

function createRunnerNode(nodeName: string, runtime: RuntimeKind, config: Record<string, unknown> = {}): RunnerNode {
	const node = new RunnerNode();
	node.node = nodeName;
	node.name = nodeName;
	node.type = `runtime.${runtime}` as any;
	node.runtime = runtime;
	node.config = config;
	return node;
}

/**
 * MockRuntimeAdapter that tracks executions and returns language-tagged data.
 */
class MockRuntimeAdapter implements RuntimeAdapter {
	readonly kind: RuntimeKind;
	public executions: Array<{
		node: string;
		timestamp: number;
		vars: Record<string, unknown>;
	}> = [];

	constructor(kind: RuntimeKind) {
		this.kind = kind;
	}

	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		this.executions.push({
			node: node.node,
			timestamp: Date.now(),
			vars: { ...ctx.vars },
		});

		// Simulate processing — each runtime writes to ctx.vars
		ctx.vars[`${this.kind}_processed`] = true;
		ctx.vars[`${this.kind}_node`] = node.node;

		const duration_ms = performance.now() - startTime;

		return {
			success: true,
			data: {
				runtime: this.kind,
				node: node.node,
				language: this.kind,
				executionIndex: this.executions.length,
			},
			errors: null,
			metrics: { duration_ms },
		};
	}
}

// ---------------------------------------------------------------------------
// All supported RuntimeKinds
// ---------------------------------------------------------------------------

const ALL_RUNTIME_KINDS: RuntimeKind[] = [
	"nodejs",
	"bun",
	"python3",
	"go",
	"java",
	"rust",
	"php",
	"csharp",
	"ruby",
	"docker",
	"wasm",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cross-Language Integration Tests (Phase 5G)", () => {
	let registry: RuntimeRegistry;

	beforeEach(() => {
		registry = RuntimeRegistry.getInstance();
		registry.clear();
	});

	afterEach(() => {
		registry.clear();
	});

	// -----------------------------------------------------------------------
	// 1. All RuntimeKinds can be registered
	// -----------------------------------------------------------------------

	describe("Complete Runtime Registration", () => {
		it("should register all 11 RuntimeKinds simultaneously", () => {
			for (const kind of ALL_RUNTIME_KINDS) {
				registry.register(new MockRuntimeAdapter(kind));
			}

			const registered = registry.getRegisteredKinds();
			expect(registered).toHaveLength(ALL_RUNTIME_KINDS.length);

			for (const kind of ALL_RUNTIME_KINDS) {
				expect(registry.has(kind)).toBe(true);
				const adapter = registry.get(kind);
				expect(adapter.kind).toBe(kind);
			}
		});

		it("should reject duplicate registration for any RuntimeKind", () => {
			for (const kind of ALL_RUNTIME_KINDS) {
				registry.register(new MockRuntimeAdapter(kind));
			}

			for (const kind of ALL_RUNTIME_KINDS) {
				expect(() => registry.register(new MockRuntimeAdapter(kind))).toThrow(
					`Runtime adapter for '${kind}' is already registered`,
				);
			}
		});

		it("should list available runtimes in error when kind is missing", () => {
			registry.register(new MockRuntimeAdapter("nodejs"));
			registry.register(new MockRuntimeAdapter("rust"));
			registry.register(new MockRuntimeAdapter("ruby"));

			expect(() => registry.get("go")).toThrow("nodejs");
			expect(() => registry.get("go")).toThrow("rust");
			expect(() => registry.get("go")).toThrow("ruby");
		});
	});

	// -----------------------------------------------------------------------
	// 2. Polyglot Workflow Simulation
	// -----------------------------------------------------------------------

	describe("Polyglot Workflow Execution", () => {
		it("should execute a NodeJS -> Go -> Rust -> Ruby pipeline", async () => {
			const adapters = {
				nodejs: new MockRuntimeAdapter("nodejs"),
				go: new MockRuntimeAdapter("go"),
				rust: new MockRuntimeAdapter("rust"),
				ruby: new MockRuntimeAdapter("ruby"),
			};

			for (const adapter of Object.values(adapters)) {
				registry.register(adapter);
			}

			const ctx = createContext();

			// Step 1: NodeJS
			const step1 = createRunnerNode("fetch-user", "nodejs");
			const result1 = await adapters.nodejs.execute(step1, ctx);
			expect(result1.success).toBe(true);
			expect(ctx.vars["nodejs_processed"]).toBe(true);

			// Step 2: Go
			const step2 = createRunnerNode("process-data", "go");
			const result2 = await adapters.go.execute(step2, ctx);
			expect(result2.success).toBe(true);
			expect(ctx.vars["go_processed"]).toBe(true);

			// Step 3: Rust
			const step3 = createRunnerNode("validate-result", "rust");
			const result3 = await adapters.rust.execute(step3, ctx);
			expect(result3.success).toBe(true);
			expect(ctx.vars["rust_processed"]).toBe(true);

			// Step 4: Ruby
			const step4 = createRunnerNode("send-notification", "ruby");
			const result4 = await adapters.ruby.execute(step4, ctx);
			expect(result4.success).toBe(true);
			expect(ctx.vars["ruby_processed"]).toBe(true);

			// Verify full pipeline context
			expect(ctx.vars["nodejs_node"]).toBe("fetch-user");
			expect(ctx.vars["go_node"]).toBe("process-data");
			expect(ctx.vars["rust_node"]).toBe("validate-result");
			expect(ctx.vars["ruby_node"]).toBe("send-notification");
		});

		it("should execute a 7-language polyglot workflow", async () => {
			const pipeline: { name: string; runtime: RuntimeKind }[] = [
				{ name: "api-gateway", runtime: "nodejs" },
				{ name: "ml-prediction", runtime: "python3" },
				{ name: "high-perf-compute", runtime: "rust" },
				{ name: "data-transform", runtime: "go" },
				{ name: "business-logic", runtime: "java" },
				{ name: "legacy-system", runtime: "php" },
				{ name: "report-generator", runtime: "csharp" },
			];

			const adapters: Record<string, MockRuntimeAdapter> = {};
			for (const step of pipeline) {
				if (!adapters[step.runtime]) {
					adapters[step.runtime] = new MockRuntimeAdapter(step.runtime);
					registry.register(adapters[step.runtime]);
				}
			}

			const ctx = createContext();

			for (const step of pipeline) {
				const node = createRunnerNode(step.name, step.runtime);
				const adapter = registry.get(step.runtime) as MockRuntimeAdapter;
				const result = await adapter.execute(node, ctx);
				expect(result.success).toBe(true);
				expect((result.data as any).runtime).toBe(step.runtime);
			}

			// All 7 runtimes should have marked the context
			for (const step of pipeline) {
				expect(ctx.vars[`${step.runtime}_processed`]).toBe(true);
				expect(ctx.vars[`${step.runtime}_node`]).toBe(step.name);
			}
		});

		it("should preserve context vars across all language boundaries", async () => {
			const runtimes: RuntimeKind[] = ["nodejs", "python3", "go", "java", "rust", "php", "csharp", "ruby"];
			const adapters: MockRuntimeAdapter[] = [];

			for (const kind of runtimes) {
				const adapter = new MockRuntimeAdapter(kind);
				adapters.push(adapter);
				registry.register(adapter);
			}

			const ctx = createContext({ initial: "value" });

			for (let i = 0; i < runtimes.length; i++) {
				const node = createRunnerNode(`step-${i}`, runtimes[i]);
				const result = await adapters[i].execute(node, ctx);
				expect(result.success).toBe(true);
			}

			// Initial value should still be present
			expect(ctx.vars["initial"]).toBe("value");

			// All runtimes should have added their markers
			for (const kind of runtimes) {
				expect(ctx.vars[`${kind}_processed`]).toBe(true);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. RuntimeAdapterNode Bridge
	// -----------------------------------------------------------------------

	describe("RuntimeAdapterNode Bridge for All Languages", () => {
		it("should wrap all RuntimeKinds through RuntimeAdapterNode", async () => {
			for (const kind of ALL_RUNTIME_KINDS) {
				const adapter = new MockRuntimeAdapter(kind);
				registry.register(adapter);
			}

			for (const kind of ALL_RUNTIME_KINDS) {
				const adapter = registry.get(kind);
				const node = createRunnerNode(`${kind}-node`, kind);
				const bridgeNode = new RuntimeAdapterNode(adapter, node);

				const ctx = createContext();
				const result = await bridgeNode.run(ctx);

				expect(result.success).toBe(true);
				expect((result.data as any).runtime).toBe(kind);
				expect((result.data as any).node).toBe(`${kind}-node`);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 4. Concurrent Cross-Language Execution
	// -----------------------------------------------------------------------

	describe("Concurrent Cross-Language Execution", () => {
		it("should handle 11 concurrent executions across all runtimes", async () => {
			for (const kind of ALL_RUNTIME_KINDS) {
				registry.register(new MockRuntimeAdapter(kind));
			}

			const results = await Promise.all(
				ALL_RUNTIME_KINDS.map(async (kind) => {
					const adapter = registry.get(kind);
					const node = createRunnerNode(`concurrent-${kind}`, kind);
					const ctx = createContext();
					return adapter.execute(node, ctx);
				}),
			);

			expect(results).toHaveLength(ALL_RUNTIME_KINDS.length);
			for (let i = 0; i < ALL_RUNTIME_KINDS.length; i++) {
				expect(results[i].success).toBe(true);
				expect((results[i].data as any).runtime).toBe(ALL_RUNTIME_KINDS[i]);
			}
		});

		it("should handle 50 concurrent cross-runtime executions", async () => {
			const runtimes: RuntimeKind[] = ["nodejs", "python3", "go", "java", "rust", "php", "csharp", "ruby"];

			for (const kind of runtimes) {
				registry.register(new MockRuntimeAdapter(kind));
			}

			const start = performance.now();

			const results = await Promise.all(
				Array.from({ length: 50 }, (_, i) => {
					const kind = runtimes[i % runtimes.length];
					const adapter = registry.get(kind);
					const node = createRunnerNode(`load-${i}`, kind);
					const ctx = createContext();
					return adapter.execute(node, ctx);
				}),
			);

			const totalMs = performance.now() - start;

			expect(results).toHaveLength(50);
			expect(results.every((r) => r.success)).toBe(true);
			expect(totalMs).toBeLessThan(1000); // Should complete in under 1s
		});
	});

	// -----------------------------------------------------------------------
	// 5. Error Isolation Across Languages
	// -----------------------------------------------------------------------

	describe("Error Isolation Across Languages", () => {
		it("should isolate errors — failure in one runtime does not affect others", async () => {
			class FailingAdapter implements RuntimeAdapter {
				readonly kind: RuntimeKind;
				constructor(kind: RuntimeKind) {
					this.kind = kind;
				}
				async execute(): Promise<ExecutionResult> {
					return {
						success: false,
						data: null,
						errors: { message: `${this.kind} execution failed` },
					};
				}
			}

			registry.register(new MockRuntimeAdapter("nodejs"));
			registry.register(new FailingAdapter("rust"));
			registry.register(new MockRuntimeAdapter("ruby"));

			const ctx = createContext();

			// Step 1: NodeJS succeeds
			const nodejsResult = await registry.get("nodejs").execute(createRunnerNode("step-1", "nodejs"), ctx);
			expect(nodejsResult.success).toBe(true);

			// Step 2: Rust fails
			const rustResult = await registry.get("rust").execute(createRunnerNode("step-2", "rust"), ctx);
			expect(rustResult.success).toBe(false);
			expect((rustResult.errors as any).message).toContain("rust execution failed");

			// Step 3: Ruby still succeeds (error doesn't propagate)
			const rubyResult = await registry.get("ruby").execute(createRunnerNode("step-3", "ruby"), ctx);
			expect(rubyResult.success).toBe(true);
		});

		it("should handle thrown exceptions from any runtime adapter", async () => {
			class ThrowingAdapter implements RuntimeAdapter {
				readonly kind: RuntimeKind;
				constructor(kind: RuntimeKind) {
					this.kind = kind;
				}
				async execute(): Promise<ExecutionResult> {
					throw new Error(`${this.kind} crashed unexpectedly`);
				}
			}

			registry.register(new ThrowingAdapter("php"));
			const node = createRunnerNode("crash-node", "php");
			const ctx = createContext();

			await expect(registry.get("php").execute(node, ctx)).rejects.toThrow("php crashed unexpectedly");
		});
	});

	// -----------------------------------------------------------------------
	// 6. Runtime Adapter Hot-Swap
	// -----------------------------------------------------------------------

	describe("Runtime Adapter Hot-Swap", () => {
		it("should hot-swap a runtime adapter and route to the new one", async () => {
			const v1 = new MockRuntimeAdapter("rust");
			registry.register(v1);

			const node = createRunnerNode("perf-node", "rust");
			const ctx1 = createContext();
			await v1.execute(node, ctx1);
			expect(v1.executions).toHaveLength(1);

			// Hot-swap with v2
			const v2 = new MockRuntimeAdapter("rust");
			registry.replace(v2);

			const ctx2 = createContext();
			const adapter = registry.get("rust") as MockRuntimeAdapter;
			await adapter.execute(node, ctx2);

			expect(v1.executions).toHaveLength(1); // v1 not called again
			expect(v2.executions).toHaveLength(1); // v2 received the call
		});
	});

	// -----------------------------------------------------------------------
	// 7. Performance — All Runtimes
	// -----------------------------------------------------------------------

	describe("Performance Across Runtimes", () => {
		it("should route 1000 sequential executions across 8 runtimes in < 500ms", async () => {
			const runtimes: RuntimeKind[] = ["nodejs", "python3", "go", "java", "rust", "php", "csharp", "ruby"];
			for (const kind of runtimes) {
				registry.register(new MockRuntimeAdapter(kind));
			}

			const start = performance.now();

			for (let i = 0; i < 1000; i++) {
				const kind = runtimes[i % runtimes.length];
				const adapter = registry.get(kind);
				const node = createRunnerNode(`perf-${i}`, kind);
				const ctx = createContext();
				const result = await adapter.execute(node, ctx);
				expect(result.success).toBe(true);
			}

			const totalMs = performance.now() - start;
			const avgMs = totalMs / 1000;

			console.log(`\n📊 Cross-Language Routing Performance:`);
			console.log(`   Total: ${totalMs.toFixed(2)}ms for 1000 executions`);
			console.log(`   Average: ${avgMs.toFixed(2)}ms per execution`);

			expect(totalMs).toBeLessThan(500);
			expect(avgMs).toBeLessThan(1);
		});
	});

	// -----------------------------------------------------------------------
	// 8. New RuntimeKinds Validation (rust, csharp, ruby)
	// -----------------------------------------------------------------------

	describe("New RuntimeKind Validation", () => {
		it.each(["rust", "php", "csharp", "ruby"] as RuntimeKind[])(
			"should support %s runtime through full lifecycle",
			async (kind) => {
				const adapter = new MockRuntimeAdapter(kind);
				registry.register(adapter);

				// Verify registration
				expect(registry.has(kind)).toBe(true);
				expect(registry.get(kind).kind).toBe(kind);

				// Execute
				const node = createRunnerNode(`${kind}-hello`, kind);
				const ctx = createContext();
				const result = await adapter.execute(node, ctx);

				expect(result.success).toBe(true);
				expect((result.data as any).runtime).toBe(kind);
				expect((result.data as any).node).toBe(`${kind}-hello`);
				expect(result.metrics?.duration_ms).toBeDefined();

				// Context propagation
				expect(ctx.vars[`${kind}_processed`]).toBe(true);

				// Bridge
				const bridgeNode = new RuntimeAdapterNode(adapter, node);
				const ctx2 = createContext();
				const bridgeResult = await bridgeNode.run(ctx2);
				expect(bridgeResult.success).toBe(true);
			},
		);
	});

	// -----------------------------------------------------------------------
	// 9. Execution Result Contract
	// -----------------------------------------------------------------------

	describe("ExecutionResult Contract Across Languages", () => {
		it("should return consistent ExecutionResult structure from all runtimes", async () => {
			for (const kind of ALL_RUNTIME_KINDS) {
				registry.register(new MockRuntimeAdapter(kind));
			}

			for (const kind of ALL_RUNTIME_KINDS) {
				const adapter = registry.get(kind);
				const node = createRunnerNode(`contract-${kind}`, kind);
				const ctx = createContext();
				const result = await adapter.execute(node, ctx);

				// Validate ExecutionResult shape
				expect(result).toHaveProperty("success");
				expect(result).toHaveProperty("data");
				expect(result).toHaveProperty("errors");
				expect(typeof result.success).toBe("boolean");
				expect(result.metrics).toBeDefined();
				expect(result.metrics?.duration_ms).toBeTypeOf("number");
			}
		});
	});
});
