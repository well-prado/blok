/**
 * DistributedTracer - OpenTelemetry distributed tracing for Blok workflows
 *
 * Creates spans for workflow and node execution, propagates trace context
 * across runtime boundaries, and correlates logs with traces via trace_id/span_id.
 *
 * Uses the OpenTelemetry API so any configured TracerProvider (OTLP, Jaeger,
 * Zipkin, Datadog, etc.) receives the spans automatically.
 *
 * Works as a no-op when no TracerProvider is registered (graceful degradation).
 *
 * @example
 * ```typescript
 * import { DistributedTracer } from "@blokjs/runner";
 *
 * const tracer = new DistributedTracer({ serviceName: "blok-http" });
 *
 * // Start a workflow span
 * const span = tracer.startWorkflowSpan("user-api", "/users/:id", { requestId: "abc" });
 *
 * // Start a child node span
 * const nodeSpan = tracer.startNodeSpan("db-query", "postgres", span);
 * // ... node execution ...
 * tracer.endNodeSpan(nodeSpan, true);
 *
 * // End workflow span
 * tracer.endWorkflowSpan(span, true);
 * ```
 */

import { type Span, SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";

export interface DistributedTracerConfig {
	/** Service name for the tracer */
	serviceName: string;
	/** Service version (default: "0.0.1") */
	serviceVersion?: string;
	/** Whether to record node-level spans (default: true) */
	traceNodes?: boolean;
	/** Whether to add request/response data as span attributes (default: false — may contain PII) */
	recordPayloads?: boolean;
	/** Max attribute value length (default: 256) */
	maxAttributeLength?: number;
}

export interface WorkflowSpanAttributes {
	requestId?: string;
	triggerType?: string;
	triggerName?: string;
	env?: string;
}

export interface NodeSpanAttributes {
	nodeType?: string;
	runtimeKind?: string;
	inputSize?: number;
	outputSize?: number;
}

export interface TraceContext {
	traceId: string;
	spanId: string;
	traceFlags: number;
}

export class DistributedTracer {
	private config: Required<DistributedTracerConfig>;
	private tracer: ReturnType<typeof trace.getTracer>;

	// Stats
	private workflowSpanCount = 0;
	private nodeSpanCount = 0;
	private errorSpanCount = 0;

	constructor(config: DistributedTracerConfig) {
		this.config = {
			serviceVersion: "0.0.1",
			traceNodes: true,
			recordPayloads: false,
			maxAttributeLength: 256,
			...config,
		};

		this.tracer = trace.getTracer(this.config.serviceName, this.config.serviceVersion);
	}

	/**
	 * Start a span for a workflow execution.
	 * This is the root span for a request flowing through a workflow.
	 */
	startWorkflowSpan(workflowName: string, workflowPath: string, attrs?: WorkflowSpanAttributes): Span {
		this.workflowSpanCount++;

		const span = this.tracer.startSpan(`workflow ${workflowName}`, {
			kind: SpanKind.SERVER,
			attributes: {
				"blok.workflow.name": workflowName,
				"blok.workflow.path": workflowPath,
				"blok.component": "runner",
				...(attrs?.requestId && { "blok.request.id": attrs.requestId }),
				...(attrs?.triggerType && { "blok.trigger.type": attrs.triggerType }),
				...(attrs?.triggerName && { "blok.trigger.name": attrs.triggerName }),
				...(attrs?.env && { "deployment.environment": attrs.env }),
			},
		});

		return span;
	}

	/**
	 * End a workflow span with success/failure status.
	 */
	endWorkflowSpan(span: Span, success: boolean, error?: Error): void {
		if (success) {
			span.setStatus({ code: SpanStatusCode.OK });
		} else {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error?.message || "Workflow execution failed",
			});
			if (error) {
				span.recordException(error);
			}
			this.errorSpanCount++;
		}

		span.end();
	}

	/**
	 * Start a child span for node execution within a workflow.
	 * The parent context is taken from the provided workflow span.
	 */
	startNodeSpan(nodeName: string, nodeType: string, parentSpan: Span, attrs?: NodeSpanAttributes): Span {
		if (!this.config.traceNodes) {
			return parentSpan;
		}

		this.nodeSpanCount++;

		const parentContext = trace.setSpan(context.active(), parentSpan);

		const span = this.tracer.startSpan(
			`node ${nodeName}`,
			{
				kind: SpanKind.INTERNAL,
				attributes: {
					"blok.node.name": nodeName,
					"blok.node.type": nodeType,
					"blok.component": "node",
					...(attrs?.runtimeKind && { "blok.runtime.kind": attrs.runtimeKind }),
					...(attrs?.inputSize && { "blok.node.input_size": attrs.inputSize }),
				},
			},
			parentContext,
		);

		return span;
	}

	/**
	 * End a node span with success/failure status.
	 */
	endNodeSpan(span: Span, success: boolean, error?: Error, attrs?: NodeSpanAttributes): void {
		if (attrs?.outputSize) {
			span.setAttribute("blok.node.output_size", attrs.outputSize);
		}

		if (success) {
			span.setStatus({ code: SpanStatusCode.OK });
		} else {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error?.message || "Node execution failed",
			});
			if (error) {
				span.recordException(error);
			}
			this.errorSpanCount++;
		}

		span.end();
	}

	/**
	 * Start a span for a runtime adapter call (e.g., gRPC to Python, Docker exec).
	 * Used when a node delegates to a non-in-process runtime.
	 */
	startRuntimeSpan(runtimeKind: string, nodeName: string, parentSpan: Span): Span {
		const parentContext = trace.setSpan(context.active(), parentSpan);

		return this.tracer.startSpan(
			`runtime ${runtimeKind}`,
			{
				kind: SpanKind.CLIENT,
				attributes: {
					"blok.runtime.kind": runtimeKind,
					"blok.node.name": nodeName,
					"blok.component": "runtime-adapter",
				},
			},
			parentContext,
		);
	}

	/**
	 * End a runtime span.
	 */
	endRuntimeSpan(span: Span, success: boolean, error?: Error): void {
		if (success) {
			span.setStatus({ code: SpanStatusCode.OK });
		} else {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error?.message || "Runtime execution failed",
			});
			if (error) {
				span.recordException(error);
			}
			this.errorSpanCount++;
		}
		span.end();
	}

	/**
	 * Add an event to a span (e.g., "input validated", "cache hit").
	 */
	addSpanEvent(span: Span, name: string, attrs?: Record<string, string | number | boolean>): void {
		span.addEvent(name, attrs);
	}

	/**
	 * Set an attribute on a span.
	 */
	setSpanAttribute(span: Span, key: string, value: string | number | boolean): void {
		if (typeof value === "string" && value.length > this.config.maxAttributeLength) {
			span.setAttribute(key, `${value.substring(0, this.config.maxAttributeLength)}...`);
		} else {
			span.setAttribute(key, value);
		}
	}

	/**
	 * Extract trace context (trace_id, span_id) from a span for log correlation.
	 * Returns { traceId, spanId, traceFlags } or null if the span is not recording.
	 */
	extractTraceContext(span: Span): TraceContext | null {
		const spanContext = span.spanContext();
		if (!spanContext || spanContext.traceId === "00000000000000000000000000000000") {
			return null;
		}

		return {
			traceId: spanContext.traceId,
			spanId: spanContext.spanId,
			traceFlags: spanContext.traceFlags,
		};
	}

	/**
	 * Get W3C Trace Context headers for propagation across service boundaries.
	 * Pass these headers when calling remote runtimes (gRPC, HTTP, Docker).
	 */
	getTraceHeaders(span: Span): Record<string, string> {
		const ctx = span.spanContext();
		if (!ctx || ctx.traceId === "00000000000000000000000000000000") {
			return {};
		}

		// W3C traceparent format: version-traceId-spanId-flags
		const traceparent = `00-${ctx.traceId}-${ctx.spanId}-${String(ctx.traceFlags).padStart(2, "0")}`;

		return { traceparent };
	}

	/**
	 * Get stats about tracer usage.
	 */
	getStats(): {
		workflowSpanCount: number;
		nodeSpanCount: number;
		errorSpanCount: number;
		totalSpans: number;
	} {
		return {
			workflowSpanCount: this.workflowSpanCount,
			nodeSpanCount: this.nodeSpanCount,
			errorSpanCount: this.errorSpanCount,
			totalSpans: this.workflowSpanCount + this.nodeSpanCount,
		};
	}

	/**
	 * Reset stats. Useful for testing.
	 */
	resetStats(): void {
		this.workflowSpanCount = 0;
		this.nodeSpanCount = 0;
		this.errorSpanCount = 0;
	}
}
