import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DistributedTracer } from "../DistributedTracer";

describe("DistributedTracer", () => {
	let tracer: DistributedTracer;

	beforeEach(() => {
		tracer = new DistributedTracer({ serviceName: "test-service" });
	});

	describe("Construction", () => {
		it("should create a tracer with default config", () => {
			const t = new DistributedTracer({ serviceName: "my-service" });
			expect(t).toBeDefined();
		});

		it("should create a tracer with custom config", () => {
			const t = new DistributedTracer({
				serviceName: "my-service",
				serviceVersion: "1.2.3",
				traceNodes: false,
				recordPayloads: true,
				maxAttributeLength: 512,
			});
			expect(t).toBeDefined();
		});
	});

	describe("Workflow Spans", () => {
		it("should start a workflow span", () => {
			const span = tracer.startWorkflowSpan("user-api", "/users/:id");
			expect(span).toBeDefined();
			expect(span.spanContext()).toBeDefined();
			span.end();
		});

		it("should start a workflow span with attributes", () => {
			const span = tracer.startWorkflowSpan("user-api", "/users/:id", {
				requestId: "req-123",
				triggerType: "http",
				triggerName: "main-http",
				env: "production",
			});
			expect(span).toBeDefined();
			span.end();
		});

		it("should end a workflow span with success", () => {
			const span = tracer.startWorkflowSpan("user-api", "/users/:id");
			// Should not throw
			tracer.endWorkflowSpan(span, true);
		});

		it("should end a workflow span with failure", () => {
			const span = tracer.startWorkflowSpan("user-api", "/users/:id");
			const error = new Error("Workflow failed");
			tracer.endWorkflowSpan(span, false, error);

			const stats = tracer.getStats();
			expect(stats.errorSpanCount).toBe(1);
		});

		it("should end a workflow span with failure without error object", () => {
			const span = tracer.startWorkflowSpan("user-api", "/users/:id");
			tracer.endWorkflowSpan(span, false);

			const stats = tracer.getStats();
			expect(stats.errorSpanCount).toBe(1);
		});

		it("should increment workflow span count", () => {
			tracer.startWorkflowSpan("wf1", "/path1").end();
			tracer.startWorkflowSpan("wf2", "/path2").end();
			tracer.startWorkflowSpan("wf3", "/path3").end();

			const stats = tracer.getStats();
			expect(stats.workflowSpanCount).toBe(3);
		});
	});

	describe("Node Spans", () => {
		it("should start a node span as child of workflow span", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const nodeSpan = tracer.startNodeSpan("db-query", "postgres", workflowSpan);
			expect(nodeSpan).toBeDefined();
			nodeSpan.end();
			workflowSpan.end();
		});

		it("should start a node span with attributes", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const nodeSpan = tracer.startNodeSpan("db-query", "postgres", workflowSpan, {
				runtimeKind: "nodejs",
				inputSize: 128,
			});
			expect(nodeSpan).toBeDefined();
			nodeSpan.end();
			workflowSpan.end();
		});

		it("should end a node span with success", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const nodeSpan = tracer.startNodeSpan("db-query", "postgres", workflowSpan);
			tracer.endNodeSpan(nodeSpan, true, undefined, { outputSize: 256 });
			workflowSpan.end();
		});

		it("should end a node span with failure", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const nodeSpan = tracer.startNodeSpan("db-query", "postgres", workflowSpan);
			tracer.endNodeSpan(nodeSpan, false, new Error("Query timeout"));
			workflowSpan.end();

			const stats = tracer.getStats();
			expect(stats.errorSpanCount).toBe(1);
		});

		it("should skip node spans when traceNodes is false", () => {
			const noNodeTracer = new DistributedTracer({
				serviceName: "test",
				traceNodes: false,
			});

			const workflowSpan = noNodeTracer.startWorkflowSpan("wf", "/path");
			const nodeSpan = noNodeTracer.startNodeSpan("db-query", "postgres", workflowSpan);

			// Should return the parent span when traceNodes is false
			expect(nodeSpan).toBe(workflowSpan);

			const stats = noNodeTracer.getStats();
			expect(stats.nodeSpanCount).toBe(0);

			workflowSpan.end();
		});

		it("should increment node span count", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			tracer.startNodeSpan("n1", "type1", workflowSpan).end();
			tracer.startNodeSpan("n2", "type2", workflowSpan).end();

			const stats = tracer.getStats();
			expect(stats.nodeSpanCount).toBe(2);
			workflowSpan.end();
		});
	});

	describe("Runtime Spans", () => {
		it("should start a runtime span", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const runtimeSpan = tracer.startRuntimeSpan("python3", "ml-model", workflowSpan);
			expect(runtimeSpan).toBeDefined();
			runtimeSpan.end();
			workflowSpan.end();
		});

		it("should end a runtime span with success", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const runtimeSpan = tracer.startRuntimeSpan("python3", "ml-model", workflowSpan);
			tracer.endRuntimeSpan(runtimeSpan, true);
			workflowSpan.end();
		});

		it("should end a runtime span with failure", () => {
			const workflowSpan = tracer.startWorkflowSpan("wf", "/path");
			const runtimeSpan = tracer.startRuntimeSpan("docker", "go-node", workflowSpan);
			tracer.endRuntimeSpan(runtimeSpan, false, new Error("Container crashed"));
			workflowSpan.end();

			expect(tracer.getStats().errorSpanCount).toBe(1);
		});
	});

	describe("Span Events & Attributes", () => {
		it("should add an event to a span", () => {
			const span = tracer.startWorkflowSpan("wf", "/path");
			// Should not throw
			tracer.addSpanEvent(span, "cache_hit", { key: "user:123" });
			tracer.addSpanEvent(span, "validation_passed");
			span.end();
		});

		it("should set an attribute on a span", () => {
			const span = tracer.startWorkflowSpan("wf", "/path");
			tracer.setSpanAttribute(span, "custom.key", "value");
			tracer.setSpanAttribute(span, "custom.number", 42);
			tracer.setSpanAttribute(span, "custom.bool", true);
			span.end();
		});

		it("should truncate long attribute values", () => {
			const smallTracer = new DistributedTracer({
				serviceName: "test",
				maxAttributeLength: 10,
			});
			const span = smallTracer.startWorkflowSpan("wf", "/path");
			// This should not throw
			smallTracer.setSpanAttribute(span, "key", "a".repeat(100));
			span.end();
		});
	});

	describe("Trace Context Extraction", () => {
		it("should extract trace context from a span", () => {
			const span = tracer.startWorkflowSpan("wf", "/path");
			const ctx = tracer.extractTraceContext(span);

			// With the no-op tracer provider, trace context may be all zeros
			expect(ctx === null || typeof ctx?.traceId === "string").toBe(true);
			span.end();
		});

		it("should return null for invalid span context", () => {
			// The default no-op provider produces zero trace IDs
			const span = tracer.startWorkflowSpan("wf", "/path");
			const ctx = tracer.extractTraceContext(span);
			// No-op provider gives zero traceId, so null is expected
			expect(ctx).toBeNull();
			span.end();
		});
	});

	describe("Trace Headers", () => {
		it("should generate trace headers", () => {
			const span = tracer.startWorkflowSpan("wf", "/path");
			const headers = tracer.getTraceHeaders(span);
			// With no-op provider, headers should be empty
			expect(typeof headers).toBe("object");
			span.end();
		});

		it("should return empty headers for no-op spans", () => {
			const span = tracer.startWorkflowSpan("wf", "/path");
			const headers = tracer.getTraceHeaders(span);
			expect(headers).toEqual({});
			span.end();
		});
	});

	describe("Stats", () => {
		it("should track all span types", () => {
			const wfSpan = tracer.startWorkflowSpan("wf", "/path");
			const nodeSpan = tracer.startNodeSpan("n1", "t1", wfSpan);
			tracer.endNodeSpan(nodeSpan, false, new Error("fail"));
			tracer.endWorkflowSpan(wfSpan, false, new Error("fail"));

			const stats = tracer.getStats();
			expect(stats.workflowSpanCount).toBe(1);
			expect(stats.nodeSpanCount).toBe(1);
			expect(stats.errorSpanCount).toBe(2);
			expect(stats.totalSpans).toBe(2);
		});

		it("should reset stats", () => {
			tracer.startWorkflowSpan("wf1", "/p1").end();
			tracer.startWorkflowSpan("wf2", "/p2").end();

			tracer.resetStats();
			const stats = tracer.getStats();
			expect(stats.workflowSpanCount).toBe(0);
			expect(stats.nodeSpanCount).toBe(0);
			expect(stats.errorSpanCount).toBe(0);
			expect(stats.totalSpans).toBe(0);
		});
	});

	describe("Full Workflow Trace", () => {
		it("should trace a complete workflow with multiple nodes", () => {
			const wfSpan = tracer.startWorkflowSpan("checkout", "/checkout", {
				requestId: "req-001",
				triggerType: "http",
				env: "test",
			});

			// Node 1: Validate
			const validateSpan = tracer.startNodeSpan("validator", "validation", wfSpan, {
				runtimeKind: "nodejs",
				inputSize: 64,
			});
			tracer.addSpanEvent(validateSpan, "schema_validated");
			tracer.endNodeSpan(validateSpan, true, undefined, { outputSize: 64 });

			// Node 2: Charge payment (Python runtime)
			const paymentSpan = tracer.startNodeSpan("charge-payment", "stripe", wfSpan, {
				runtimeKind: "python3",
			});
			const runtimeSpan = tracer.startRuntimeSpan("python3", "charge-payment", paymentSpan);
			tracer.endRuntimeSpan(runtimeSpan, true);
			tracer.endNodeSpan(paymentSpan, true);

			// Node 3: Send email
			const emailSpan = tracer.startNodeSpan("send-email", "sendgrid", wfSpan);
			tracer.endNodeSpan(emailSpan, true);

			tracer.endWorkflowSpan(wfSpan, true);

			const stats = tracer.getStats();
			expect(stats.workflowSpanCount).toBe(1);
			expect(stats.nodeSpanCount).toBe(3);
			expect(stats.errorSpanCount).toBe(0);
			expect(stats.totalSpans).toBe(4); // 1 workflow + 3 nodes
		});

		it("should trace a workflow with a failing node", () => {
			const wfSpan = tracer.startWorkflowSpan("order", "/orders");

			const nodeSpan = tracer.startNodeSpan("db-write", "postgres", wfSpan);
			tracer.endNodeSpan(nodeSpan, false, new Error("Connection refused"));

			tracer.endWorkflowSpan(wfSpan, false, new Error("Workflow failed: db-write error"));

			const stats = tracer.getStats();
			expect(stats.errorSpanCount).toBe(2); // node + workflow
		});
	});
});
