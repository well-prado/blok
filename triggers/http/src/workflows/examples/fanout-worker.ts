import { workflow } from "@blokjs/helper";

export default workflow({
	name: "fanout-worker",
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
	steps: [
		{
			id: "process-item",
			use: "@blokjs/audit-log",
			type: "module",
			inputs: {
				event: "fanout-job-processed",
				attrs: {
					jobId: "js/ctx.request.params.jobId",
					queue: "js/ctx.request.params.queue",
					attempt: "js/ctx.request.params.attempt",
					tenantId: "js/ctx.request.body.tenantId",
					itemIndex: "js/ctx.request.body.index",
					item: "js/ctx.request.body.item",
				},
			},
			idempotencyKey: "js/ctx.request.params.jobId",
			retry: { maxAttempts: 3, minTimeoutInMs: 500 },
		},
		{
			id: "summary",
			use: "@blokjs/expr",
			type: "module",
			inputs: {
				expression:
					"({ jobId: ctx.request.params.jobId, tenantId: ctx.request.body.tenantId || 'default', itemIndex: ctx.request.body.index, processedAt: Date.now() })",
			},
		},
	],
});
