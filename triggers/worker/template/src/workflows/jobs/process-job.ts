import { node, step, workflow } from "@blokjs/core";

/**
 * Example Worker workflow — fires when a job is received from the queue.
 *
 * The `job` entry handle is the job payload + metadata:
 *   - job.body              — the job payload as posted
 *   - job.headers           — job headers
 *   - job.params.queue      — queue name
 *   - job.params.jobId      — unique job ID
 *   - job.params.attempt    — retry attempt (0-based)
 *
 * v2 reliability knobs available as step()'s 4th arg (uncomment to use):
 *   { idempotencyKey: job.params.jobId }  — skip re-runs of the same job
 *   { retry: { maxAttempts: 3 } }          — retry on transient failures
 *   { maxDuration: "30s" }                 — fail the step if it hangs
 *
 * Trigger-level reliability (on the `worker` block):
 *   concurrencyKey: "$.req.body.tenantId"  — per-tenant fairness
 *   onLimit: "queue"                        — defer instead of reject
 */
export default workflow(
	"Process Background Job",
	{
		version: "1.0.0",
		trigger: { worker: { queue: "background-jobs" } },
	},
	(job) => {
		step("process-job", node("@blokjs/api-call"), {
			url: "https://httpbin.org/post",
			method: "POST",
			body: {
				job: job.body,
				queue: job.params.queue,
				jobId: job.params.jobId,
				attempt: job.params.attempt,
			},
		});
	},
);
