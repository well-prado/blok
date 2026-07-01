import type { Handle } from "@blokjs/core";
import { node, step, workflow } from "@blokjs/core";

export default workflow(
	"fanout-worker",
	{
		version: "1.0.0",
		description:
			"v0.6.10 — Fan-out consumer. Worker trigger subscribes to queue `fanout-jobs` and processes each item enqueued by fanout-enqueue. Demonstrates two reliability knobs together: (1) `concurrencyKey: $.req.body.tenantId` on the trigger limits in-flight processing to 3 jobs per tenant — keeps a noisy tenant from starving others; (2) `idempotencyKey: $.req.params.jobId` on the process step caches the result by job id so retry attempts on the same job are no-ops. Logs each processed item via @blokjs/audit-log so the run is visible in Studio. Real handlers would do the actual work (image resize, email send, ETL row, etc.) inside the `process-item` step.",
		trigger: {
			worker: {
				queue: "fanout-jobs",
				concurrency: 10,
				concurrencyKey: "js/ctx.request.body.tenantId || 'default'",
				concurrencyLimit: 3,
			},
		},
	},
	(job) => {
		const body = job.body as Handle<{ tenantId: string; index: number; item: unknown }>;
		step(
			"process-item",
			node("@blokjs/audit-log"),
			{
				event: "fanout-job-processed",
				attrs: {
					jobId: job.params.jobId,
					queue: job.params.queue,
					attempt: job.params.attempt,
					tenantId: body.tenantId,
					itemIndex: body.index,
					item: body.item,
				},
			},
			{
				idempotencyKey: job.params.jobId,
				retry: { maxAttempts: 3, minTimeoutInMs: 500 },
			},
		);
		step("summary", node("@blokjs/expr"), {
			expression:
				"({ jobId: ctx.request.params.jobId, tenantId: ctx.request.body.tenantId || 'default', itemIndex: ctx.request.body.index, processedAt: Date.now() })",
		});
	},
);
