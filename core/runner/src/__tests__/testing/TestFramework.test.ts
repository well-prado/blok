/**
 * Comprehensive tests for the Testing Framework
 *
 * Covers:
 *   - TestLogger: log capture, filtering, assertions, clear/reset
 *   - NodeTestHarness: execute, assert helpers, metrics, history
 *   - WorkflowTestRunner: registration, mocking, workflow loading, execution, tracing
 */

import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";

import { TestLogger } from "../../testing/TestLogger";
import { NodeTestHarness } from "../../testing/TestHarness";
import { WorkflowTestRunner } from "../../testing/WorkflowTestRunner";
import { defineNode } from "../../defineNode";

// ---------------------------------------------------------------------------
// Shared test nodes created via defineNode
// ---------------------------------------------------------------------------

const addNode = defineNode({
	name: "test-add",
	description: "Adds two numbers",
	input: z.object({ a: z.number(), b: z.number() }),
	output: z.object({ sum: z.number() }),
	async execute(_ctx, input) {
		return { sum: input.a + input.b };
	},
});

const failingNode = defineNode({
	name: "test-fail",
	description: "Always throws an error",
	input: z.object({ msg: z.string() }),
	output: z.object({ result: z.string() }),
	async execute(_ctx, input) {
		throw new Error(input.msg);
	},
});

const loggingNode = defineNode({
	name: "test-logging",
	description: "Logs messages at various levels",
	input: z.object({}),
	output: z.object({ done: z.boolean() }),
	async execute(ctx) {
		ctx.logger.info("info message from node");
		ctx.logger.warn("warn message from node");
		return { done: true };
	},
});

// ==========================================================================
//  TestLogger
// ==========================================================================
describe("TestLogger", () => {
	let logger: TestLogger;

	beforeEach(() => {
		logger = new TestLogger();
	});

	// ---- Basic capture ---------------------------------------------------

	describe("log capture methods", () => {
		it("should capture info() messages", () => {
			logger.info("hello info");
			expect(logger.getLogs()).toContain("hello info");
		});

		it("should capture warn() messages", () => {
			logger.warn("hello warn");
			expect(logger.getLogs()).toContain("hello warn");
		});

		it("should capture error() messages", () => {
			logger.error("hello error");
			expect(logger.getLogs()).toContain("hello error");
		});

		it("should capture debug() messages", () => {
			logger.debug("hello debug");
			expect(logger.getLogs()).toContain("hello debug");
		});

		it("should capture multiple messages in order", () => {
			logger.info("first");
			logger.warn("second");
			logger.error("third");
			logger.debug("fourth");
			expect(logger.getLogs()).toEqual(["first", "second", "third", "fourth"]);
		});
	});

	// ---- getLogs / getEntries ---------------------------------------------

	describe("getLogs()", () => {
		it("should return an empty array when no messages logged", () => {
			expect(logger.getLogs()).toEqual([]);
		});

		it("should return only message strings", () => {
			logger.info("a");
			logger.warn("b");
			const logs = logger.getLogs();
			expect(logs).toEqual(["a", "b"]);
			logs.forEach((msg) => {
				expect(typeof msg).toBe("string");
			});
		});
	});

	describe("getEntries()", () => {
		it("should return full LogEntry objects with level and timestamp", () => {
			const before = Date.now();
			logger.info("entry-test");
			const after = Date.now();

			const entries = logger.getEntries();
			expect(entries).toHaveLength(1);

			const entry = entries[0];
			expect(entry.level).toBe("info");
			expect(entry.message).toBe("entry-test");
			expect(entry.timestamp).toBeGreaterThanOrEqual(before);
			expect(entry.timestamp).toBeLessThanOrEqual(after);
		});

		it("should return a defensive copy", () => {
			logger.info("original");
			const entries1 = logger.getEntries();
			const entries2 = logger.getEntries();
			expect(entries1).not.toBe(entries2);
			expect(entries1).toEqual(entries2);
		});
	});

	// ---- getLogsByLevel ---------------------------------------------------

	describe("getLogsByLevel()", () => {
		it("should filter entries by level", () => {
			logger.info("i1");
			logger.warn("w1");
			logger.info("i2");
			logger.error("e1");
			logger.debug("d1");

			const infos = logger.getLogsByLevel("info");
			expect(infos).toHaveLength(2);
			expect(infos.every((e) => e.level === "info")).toBe(true);

			const warns = logger.getLogsByLevel("warn");
			expect(warns).toHaveLength(1);
			expect(warns[0].message).toBe("w1");

			const errors = logger.getLogsByLevel("error");
			expect(errors).toHaveLength(1);
			expect(errors[0].message).toBe("e1");

			const debugs = logger.getLogsByLevel("debug");
			expect(debugs).toHaveLength(1);
			expect(debugs[0].message).toBe("d1");
		});

		it("should return an empty array for a level with no entries", () => {
			logger.info("only info");
			expect(logger.getLogsByLevel("error")).toEqual([]);
		});
	});

	// ---- assertLogged / assertNotLogged -----------------------------------

	describe("assertLogged()", () => {
		it("should pass when the exact string is found", () => {
			logger.info("User created successfully");
			expect(() => logger.assertLogged("User created")).not.toThrow();
		});

		it("should pass when matching with a RegExp", () => {
			logger.warn("Rate limit 80%");
			expect(() => logger.assertLogged(/rate limit/i)).not.toThrow();
		});

		it("should pass when filtering by level", () => {
			logger.info("shared message");
			logger.error("shared message");
			expect(() => logger.assertLogged("shared message", "error")).not.toThrow();
		});

		it("should throw when the message was not logged", () => {
			logger.info("something else");
			expect(() => logger.assertLogged("never logged")).toThrow(/Expected log message/);
		});

		it("should throw when the message exists at a different level", () => {
			logger.info("only at info");
			expect(() => logger.assertLogged("only at info", "error")).toThrow();
		});

		it("should throw when no messages logged at all", () => {
			expect(() => logger.assertLogged("anything")).toThrow();
		});
	});

	describe("assertNotLogged()", () => {
		it("should pass when the message was not logged", () => {
			logger.info("something");
			expect(() => logger.assertNotLogged("absent")).not.toThrow();
		});

		it("should pass when message exists at a different level", () => {
			logger.info("only info");
			expect(() => logger.assertNotLogged("only info", "error")).not.toThrow();
		});

		it("should pass with RegExp when not found", () => {
			logger.info("hello world");
			expect(() => logger.assertNotLogged(/foobar/)).not.toThrow();
		});

		it("should throw when the message was logged", () => {
			logger.error("bad thing");
			expect(() => logger.assertNotLogged("bad thing")).toThrow(/NOT be present/);
		});

		it("should throw when the message matches RegExp", () => {
			logger.warn("Rate limit exceeded");
			expect(() => logger.assertNotLogged(/rate limit/i)).toThrow();
		});
	});

	// ---- clear / count ----------------------------------------------------

	describe("clear()", () => {
		it("should reset all captured entries", () => {
			logger.info("a");
			logger.warn("b");
			expect(logger.count).toBe(2);

			logger.clear();

			expect(logger.count).toBe(0);
			expect(logger.getLogs()).toEqual([]);
			expect(logger.getEntries()).toEqual([]);
		});
	});

	describe("count", () => {
		it("should return 0 initially", () => {
			expect(logger.count).toBe(0);
		});

		it("should increment with each log call", () => {
			logger.info("1");
			expect(logger.count).toBe(1);
			logger.warn("2");
			expect(logger.count).toBe(2);
			logger.error("3");
			expect(logger.count).toBe(3);
			logger.debug("4");
			expect(logger.count).toBe(4);
		});
	});
});

// ==========================================================================
//  NodeTestHarness
// ==========================================================================
describe("NodeTestHarness", () => {
	// ---- Construction ----------------------------------------------------

	describe("construction", () => {
		it("should create a harness with a FunctionNode from defineNode", () => {
			const harness = new NodeTestHarness(addNode);
			expect(harness).toBeDefined();
		});
	});

	// ---- execute() -------------------------------------------------------

	describe("execute()", () => {
		it("should return a successful TestResult for a passing node", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute({ a: 2, b: 3 });

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ sum: 5 });
			expect(result.error).toBeNull();
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(result.logs)).toBe(true);
			expect(result.context).toBeDefined();
		});

		it("should return a failed TestResult when the node throws", async () => {
			const harness = new NodeTestHarness(failingNode);
			const result = await harness.execute({ msg: "boom" });

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.error).toBeDefined();
		});

		it("should return a failed TestResult for invalid input (Zod validation)", async () => {
			const harness = new NodeTestHarness(addNode);
			// Pass strings instead of numbers to trigger Zod validation error
			const result = await harness.execute({ a: "not-a-number", b: "also-not" } as any);

			expect(result.success).toBe(false);
			expect(result.data).toBeNull();
			expect(result.error).toBeDefined();
		});

		it("should capture logs produced during node execution", async () => {
			const harness = new NodeTestHarness(loggingNode);
			const result = await harness.execute({});

			expect(result.logs.length).toBeGreaterThanOrEqual(2);
			expect(result.logs).toContain("info message from node");
			expect(result.logs).toContain("warn message from node");
		});

		it("should populate context defaults when no overrides supplied", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute({ a: 1, b: 1 });

			expect(result.context.workflow_name).toBe("test-workflow");
			expect(result.context.workflow_path).toBe("/test");
			expect(result.context.id).toBeDefined();
		});

		it("should apply context overrides when provided", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute(
				{ a: 1, b: 1 },
				{
					workflow_name: "my-custom-workflow",
					vars: { key: "value" },
				},
			);

			expect(result.context.workflow_name).toBe("my-custom-workflow");
			expect((result.context.vars as Record<string, any>).key).toBe("value");
		});
	});

	// ---- assertSuccess / assertError --------------------------------------

	describe("assertSuccess()", () => {
		it("should not throw for a successful result", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute({ a: 1, b: 2 });

			expect(() => harness.assertSuccess(result)).not.toThrow();
		});

		it("should throw for a failed result", async () => {
			const harness = new NodeTestHarness(failingNode);
			const result = await harness.execute({ msg: "oops" });

			expect(() => harness.assertSuccess(result)).toThrow(/Expected node to succeed/);
		});
	});

	describe("assertError()", () => {
		it("should not throw for a failed result", async () => {
			const harness = new NodeTestHarness(failingNode);
			const result = await harness.execute({ msg: "crash" });

			expect(() => harness.assertError(result)).not.toThrow();
		});

		it("should throw for a successful result", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute({ a: 1, b: 2 });

			expect(() => harness.assertError(result)).toThrow(/Expected node to fail/);
		});

		it("should match error message with string", async () => {
			const harness = new NodeTestHarness(failingNode);
			const result = await harness.execute({ msg: "specific failure" });

			expect(() => harness.assertError(result, "specific failure")).not.toThrow();
		});

		it("should match error message with RegExp", async () => {
			const harness = new NodeTestHarness(failingNode);
			const result = await harness.execute({ msg: "something went wrong" });

			expect(() => harness.assertError(result, /went wrong/)).not.toThrow();
		});
	});

	// ---- assertOutput() ---------------------------------------------------

	describe("assertOutput()", () => {
		it("should pass when output matches the expected partial object", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute({ a: 10, b: 20 });

			expect(() => harness.assertOutput(result, { sum: 30 })).not.toThrow();
		});

		it("should throw when output does not match", async () => {
			const harness = new NodeTestHarness(addNode);
			const result = await harness.execute({ a: 1, b: 2 });

			expect(() => harness.assertOutput(result, { sum: 999 })).toThrow(/Output mismatch/);
		});

		it("should throw when called on a failed result", async () => {
			const harness = new NodeTestHarness(failingNode);
			const result = await harness.execute({ msg: "err" });

			expect(() => harness.assertOutput(result, {} as any)).toThrow(
				/Cannot assert output.*failed/,
			);
		});

		it("should allow partial matching (subset of keys)", async () => {
			const multiOutputNode = defineNode({
				name: "multi-out",
				description: "Returns multiple fields",
				input: z.object({}),
				output: z.object({ x: z.number(), y: z.string(), z: z.boolean() }),
				async execute() {
					return { x: 42, y: "hello", z: true };
				},
			});

			const harness = new NodeTestHarness(multiOutputNode);
			const result = await harness.execute({});

			// Only assert a subset of keys
			expect(() => harness.assertOutput(result, { x: 42 })).not.toThrow();
			expect(() => harness.assertOutput(result, { y: "hello" })).not.toThrow();
			expect(() => harness.assertOutput(result, { x: 42, z: true })).not.toThrow();
		});
	});

	// ---- getMetrics() ----------------------------------------------------

	describe("getMetrics()", () => {
		it("should start with zero executions", () => {
			const harness = new NodeTestHarness(addNode);
			const metrics = harness.getMetrics();

			expect(metrics.totalExecutions).toBe(0);
			expect(metrics.successCount).toBe(0);
			expect(metrics.failureCount).toBe(0);
			expect(metrics.avgDurationMs).toBe(0);
			expect(metrics.lastDurationMs).toBe(0);
		});

		it("should track execution count after runs", async () => {
			const harness = new NodeTestHarness(addNode);

			await harness.execute({ a: 1, b: 1 });
			await harness.execute({ a: 2, b: 2 });

			const metrics = harness.getMetrics();
			expect(metrics.totalExecutions).toBe(2);
			expect(metrics.successCount).toBe(2);
			expect(metrics.failureCount).toBe(0);
		});

		it("should track success and failure counts separately", async () => {
			const harness = new NodeTestHarness(addNode);

			await harness.execute({ a: 1, b: 1 }); // success
			await harness.execute({ a: "bad", b: "input" } as any); // fail (Zod)

			const metrics = harness.getMetrics();
			expect(metrics.totalExecutions).toBe(2);
			expect(metrics.successCount).toBe(1);
			expect(metrics.failureCount).toBe(1);
		});

		it("should compute avgDurationMs", async () => {
			const harness = new NodeTestHarness(addNode);

			await harness.execute({ a: 1, b: 2 });
			await harness.execute({ a: 3, b: 4 });

			const metrics = harness.getMetrics();
			expect(metrics.avgDurationMs).toBeGreaterThan(0);
			expect(metrics.lastDurationMs).toBeGreaterThan(0);
		});
	});

	// ---- getHistory() ----------------------------------------------------

	describe("getHistory()", () => {
		it("should return an empty array before any executions", () => {
			const harness = new NodeTestHarness(addNode);
			expect(harness.getHistory()).toEqual([]);
		});

		it("should return all results in execution order", async () => {
			const harness = new NodeTestHarness(addNode);

			await harness.execute({ a: 1, b: 1 });
			await harness.execute({ a: 2, b: 2 });
			await harness.execute({ a: 3, b: 3 });

			const history = harness.getHistory();
			expect(history).toHaveLength(3);
			expect(history[0].data).toEqual({ sum: 2 });
			expect(history[1].data).toEqual({ sum: 4 });
			expect(history[2].data).toEqual({ sum: 6 });
		});

		it("should return a defensive copy", async () => {
			const harness = new NodeTestHarness(addNode);
			await harness.execute({ a: 1, b: 1 });

			const history1 = harness.getHistory();
			const history2 = harness.getHistory();
			expect(history1).not.toBe(history2);
			expect(history1).toEqual(history2);
		});
	});

	// ---- reset() ---------------------------------------------------------

	describe("reset()", () => {
		it("should clear execution history and metrics", async () => {
			const harness = new NodeTestHarness(addNode);
			await harness.execute({ a: 1, b: 2 });
			await harness.execute({ a: 3, b: 4 });

			expect(harness.getHistory()).toHaveLength(2);
			expect(harness.getMetrics().totalExecutions).toBe(2);

			harness.reset();

			expect(harness.getHistory()).toHaveLength(0);
			expect(harness.getMetrics().totalExecutions).toBe(0);
		});

		it("should still allow new executions after reset", async () => {
			const harness = new NodeTestHarness(addNode);
			await harness.execute({ a: 1, b: 2 });
			harness.reset();

			const result = await harness.execute({ a: 10, b: 20 });
			expect(result.success).toBe(true);
			expect(result.data).toEqual({ sum: 30 });
			expect(harness.getHistory()).toHaveLength(1);
		});
	});
});

// ==========================================================================
//  WorkflowTestRunner
// ==========================================================================
describe("WorkflowTestRunner", () => {
	let runner: WorkflowTestRunner;

	beforeEach(() => {
		runner = new WorkflowTestRunner();
	});

	// ---- registerNode / mockNode ------------------------------------------

	describe("registerNode() and mockNode()", () => {
		it("should register a real FunctionNode", () => {
			// Should not throw
			expect(() => runner.registerNode("add", addNode)).not.toThrow();
		});

		it("should register a mock node with a handler", () => {
			expect(() =>
				runner.mockNode("fetch-data", async (input) => {
					return { fetched: true, id: input.id };
				}),
			).not.toThrow();
		});

		it("should allow registering multiple nodes", async () => {
			runner.mockNode("step-a", async () => ({ a: 1 }));
			runner.mockNode("step-b", async () => ({ b: 2 }));
			runner.mockNode("step-c", async () => ({ c: 3 }));

			// Verify they work by loading and executing a workflow
			runner.loadWorkflow({
				name: "multi-node",
				steps: [
					{ name: "s1", node: "step-a" },
					{ name: "s2", node: "step-b" },
					{ name: "s3", node: "step-c" },
				],
			});

			// No throw means all nodes are registered
			await expect(runner.execute({})).resolves.toBeDefined();
		});
	});

	// ---- loadWorkflow() ---------------------------------------------------

	describe("loadWorkflow()", () => {
		it("should load a valid workflow object", () => {
			expect(() =>
				runner.loadWorkflow({
					name: "test-workflow",
					steps: [{ name: "step1", node: "some-node" }],
				}),
			).not.toThrow();
		});

		it("should load a workflow from a JSON string", () => {
			const json = JSON.stringify({
				name: "from-string",
				steps: [{ name: "s1", node: "node-a" }],
			});

			expect(() => runner.loadWorkflow(json)).not.toThrow();
		});

		it("should throw for a workflow without steps", () => {
			expect(() => runner.loadWorkflow({ name: "bad" } as any)).toThrow(
				/must have a 'steps' array/,
			);
		});

		it("should throw for a workflow where steps is not an array", () => {
			expect(() => runner.loadWorkflow({ steps: "not-an-array" } as any)).toThrow(
				/must have a 'steps' array/,
			);
		});
	});

	// ---- execute() --------------------------------------------------------

	describe("execute()", () => {
		it("should throw when no workflow is loaded", async () => {
			await expect(runner.execute({})).rejects.toThrow(/No workflow loaded/);
		});

		it("should execute steps in order", async () => {
			const executionOrder: string[] = [];

			runner.mockNode("node-a", async () => {
				executionOrder.push("a");
				return { from: "a" };
			});
			runner.mockNode("node-b", async () => {
				executionOrder.push("b");
				return { from: "b" };
			});
			runner.mockNode("node-c", async () => {
				executionOrder.push("c");
				return { from: "c" };
			});

			runner.loadWorkflow({
				name: "ordered",
				steps: [
					{ name: "first", node: "node-a" },
					{ name: "second", node: "node-b" },
					{ name: "third", node: "node-c" },
				],
			});

			const result = await runner.execute({});

			expect(result.success).toBe(true);
			expect(executionOrder).toEqual(["a", "b", "c"]);
		});

		it("should fail if a required node is not registered", async () => {
			runner.loadWorkflow({
				name: "missing-node",
				steps: [{ name: "s1", node: "unregistered-node" }],
			});

			const result = await runner.execute({});
			expect(result.success).toBe(false);
			expect(result.output).toBeDefined();
			expect(result.output.message).toMatch(/not registered/);
		});

		it("should pass step inputs to the node", async () => {
			let capturedInput: any;

			runner.mockNode("echo", async (input) => {
				capturedInput = input;
				return { echoed: true };
			});

			runner.loadWorkflow({
				steps: [
					{ name: "s1", node: "echo", inputs: { greeting: "hello", count: 42 } },
				],
			});

			await runner.execute({});

			expect(capturedInput).toEqual({ greeting: "hello", count: 42 });
		});

		it("should update context response between steps", async () => {
			runner.mockNode("producer", async () => {
				return { value: 100 };
			});

			let receivedInput: any;
			runner.mockNode("consumer", async (input) => {
				receivedInput = input;
				return { consumed: true };
			});

			runner.loadWorkflow({
				steps: [
					{ name: "s1", node: "producer", inputs: { seed: 1 } },
					{ name: "s2", node: "consumer" }, // no explicit inputs => uses previous response
				],
			});

			await runner.execute({});

			// Consumer receives the output of the producer as response.data
			expect(receivedInput).toEqual({ value: 100 });
		});

		it("should return a WorkflowTestResult with correct structure", async () => {
			runner.mockNode("simple", async () => ({ ok: true }));

			runner.loadWorkflow({
				name: "result-check",
				steps: [{ name: "s1", node: "simple" }],
			});

			const result = await runner.execute({ input: "data" });

			expect(result.success).toBe(true);
			expect(result.output).toEqual({ ok: true });
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.trace).toHaveLength(1);
			expect(result.nodeResults).toBeInstanceOf(Map);
			expect(result.nodeResults.get("s1")).toBeDefined();
		});

		it("should propagate failure when a step throws", async () => {
			runner.mockNode("ok-node", async () => ({ fine: true }));
			runner.mockNode("bad-node", async () => {
				throw new Error("step explosion");
			});

			runner.loadWorkflow({
				steps: [
					{ name: "s1", node: "ok-node" },
					{ name: "s2", node: "bad-node" },
				],
			});

			const result = await runner.execute({});

			expect(result.success).toBe(false);
		});
	});

	// ---- mockAllNodes mode -----------------------------------------------

	describe("mockAllNodes mode", () => {
		it("should auto-mock unregistered nodes when enabled", async () => {
			const autoRunner = new WorkflowTestRunner({ mockAllNodes: true });

			autoRunner.loadWorkflow({
				steps: [
					{ name: "s1", node: "unknown-node-a" },
					{ name: "s2", node: "unknown-node-b" },
				],
			});

			const result = await autoRunner.execute({});

			expect(result.success).toBe(true);
			expect(result.trace).toHaveLength(2);
		});

		it("should use registered nodes even when mockAllNodes is enabled", async () => {
			const autoRunner = new WorkflowTestRunner({ mockAllNodes: true });
			let realNodeCalled = false;

			autoRunner.mockNode("real-node", async () => {
				realNodeCalled = true;
				return { real: true };
			});

			autoRunner.loadWorkflow({
				steps: [
					{ name: "s1", node: "real-node" },
					{ name: "s2", node: "auto-mocked-node" },
				],
			});

			const result = await autoRunner.execute({});

			expect(result.success).toBe(true);
			expect(realNodeCalled).toBe(true);
		});

		it("should fail for unregistered nodes when mockAllNodes is disabled", async () => {
			const strictRunner = new WorkflowTestRunner({ mockAllNodes: false });

			strictRunner.loadWorkflow({
				steps: [{ name: "s1", node: "missing" }],
			});

			const result = await strictRunner.execute({});
			expect(result.success).toBe(false);
			expect(result.output).toBeDefined();
			expect(result.output.message).toMatch(/not registered/);
		});
	});

	// ---- getTrace() -------------------------------------------------------

	describe("getTrace()", () => {
		it("should return an empty trace before execution", () => {
			expect(runner.getTrace()).toEqual([]);
		});

		it("should return execution trace entries after execution", async () => {
			runner.mockNode("traced-a", async () => ({ a: 1 }));
			runner.mockNode("traced-b", async () => ({ b: 2 }));

			runner.loadWorkflow({
				steps: [
					{ name: "first", node: "traced-a" },
					{ name: "second", node: "traced-b" },
				],
			});

			await runner.execute({});

			const trace = runner.getTrace();

			expect(trace).toHaveLength(2);

			// First trace entry
			expect(trace[0].nodeName).toBe("first");
			expect(trace[0].stepIndex).toBe(0);
			expect(trace[0].success).toBe(true);
			expect(trace[0].output).toEqual({ a: 1 });
			expect(trace[0].durationMs).toBeGreaterThanOrEqual(0);
			expect(trace[0].timestamp).toBeGreaterThan(0);

			// Second trace entry
			expect(trace[1].nodeName).toBe("second");
			expect(trace[1].stepIndex).toBe(1);
			expect(trace[1].success).toBe(true);
			expect(trace[1].output).toEqual({ b: 2 });
		});

		it("should include error info in trace for failed steps", async () => {
			runner.mockNode("will-fail", async () => {
				throw new Error("trace failure");
			});

			runner.loadWorkflow({
				steps: [{ name: "broken", node: "will-fail" }],
			});

			const result = await runner.execute({});
			expect(result.success).toBe(false);

			const trace = runner.getTrace();
			expect(trace.length).toBeGreaterThanOrEqual(1);

			// Find the failed trace entry
			const failedEntry = trace.find((t) => t.success === false);
			expect(failedEntry).toBeDefined();
			expect(failedEntry!.error).toBeDefined();
		});

		it("should return a defensive copy", async () => {
			runner.mockNode("node-x", async () => ({}));
			runner.loadWorkflow({ steps: [{ name: "s1", node: "node-x" }] });
			await runner.execute({});

			const trace1 = runner.getTrace();
			const trace2 = runner.getTrace();
			expect(trace1).not.toBe(trace2);
			expect(trace1).toEqual(trace2);
		});
	});

	// ---- reset / resetAll -------------------------------------------------

	describe("reset()", () => {
		it("should clear workflow, trace, and node results but keep registered nodes", async () => {
			runner.mockNode("kept-node", async () => ({ kept: true }));

			runner.loadWorkflow({
				steps: [{ name: "s1", node: "kept-node" }],
			});

			await runner.execute({});
			expect(runner.getTrace()).toHaveLength(1);

			runner.reset();

			expect(runner.getTrace()).toEqual([]);

			// Nodes should still be registered; we can load a new workflow and run
			runner.loadWorkflow({
				steps: [{ name: "s2", node: "kept-node" }],
			});

			const result = await runner.execute({});
			expect(result.success).toBe(true);
		});
	});

	describe("resetAll()", () => {
		it("should clear everything including registered nodes", async () => {
			runner.mockNode("doomed-node", async () => ({ data: 1 }));

			runner.loadWorkflow({
				steps: [{ name: "s1", node: "doomed-node" }],
			});

			await runner.execute({});

			runner.resetAll();

			expect(runner.getTrace()).toEqual([]);

			// Node is gone, so execution should fail
			runner.loadWorkflow({
				steps: [{ name: "s1", node: "doomed-node" }],
			});

			const result = await runner.execute({});
			expect(result.success).toBe(false);
			expect(result.output).toBeDefined();
			expect(result.output.message).toMatch(/not registered/);
		});
	});

	// ---- Additional integration-level tests --------------------------------

	describe("integration scenarios", () => {
		it("should support re-execution of the same workflow", async () => {
			runner.mockNode("counter", async (input) => {
				return { count: (input.count ?? 0) + 1 };
			});

			runner.loadWorkflow({
				steps: [{ name: "s1", node: "counter", inputs: { count: 0 } }],
			});

			const result1 = await runner.execute({});
			const result2 = await runner.execute({});

			expect(result1.success).toBe(true);
			expect(result2.success).toBe(true);

			// Trace should be from the most recent execution
			expect(runner.getTrace()).toHaveLength(1);
		});

		it("should handle workflows with a single step", async () => {
			runner.mockNode("solo", async () => ({ solo: true }));
			runner.loadWorkflow({ steps: [{ name: "only", node: "solo" }] });

			const result = await runner.execute({ data: "input" });

			expect(result.success).toBe(true);
			expect(result.trace).toHaveLength(1);
			expect(result.output).toEqual({ solo: true });
		});

		it("should work with defineNode-created nodes via registerNode", async () => {
			runner.registerNode("test-add", addNode);

			runner.loadWorkflow({
				steps: [
					{ name: "add-step", node: "test-add", inputs: { a: 7, b: 8 } },
				],
			});

			const result = await runner.execute({});

			expect(result.success).toBe(true);
			expect(result.output).toEqual({ sum: 15 });
		});
	});
});
