import { workflow } from "@blokjs/helper";

/**
 * Example Worker workflow — fires when a job is received from the queue.
 *
 * The job payload + metadata land on ctx.request:
 *   - ctx.request.body                 — the job payload as posted
 *   - ctx.request.headers              — job headers
 *   - ctx.request.params.queue         — queue name
 *   - ctx.request.params.jobId         — unique job ID
 *   - ctx.request.params.attempt       — retry attempt (0-based)
 *   - ctx.vars._worker_job             — full job metadata
 *
 * v2 reliability knobs available on each step (uncomment to use):
 *   idempotencyKey: "$.req.params.jobId"    — skip re-runs of the same job
 *   retry: { maxAttempts: 3 }                — retry on transient failures
 *   maxDuration: "30s"                       — fail the step if it hangs
 *
 * Trigger-level reliability:
 *   concurrencyKey: "$.req.body.tenantId"    — per-tenant fairness
 *   onLimit: "queue"                          — defer instead of reject
 */
export default workflow({
	name: "Process Background Job",
	version: "1.0.0",
	description: "Handles incoming worker jobs from the queue",
	trigger: {
		worker: { queue: "background-jobs" },
	},
	steps: [
		{
			id: "process-job",
			use: "@blokjs/api-call",
			type: "module",
			inputs: {
				url: "https://httpbin.org/post",
				method: "POST",
				body: {
					job: "js/ctx.request.body",
					queue: "js/ctx.request.params.queue",
					jobId: "js/ctx.request.params.jobId",
					attempt: "js/ctx.request.params.attempt",
				},
			},
		},
	],
});
