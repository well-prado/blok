import { type Step, Workflow } from "@blokjs/helper";

/**
 * Example Worker workflow - triggered when a job is received from the queue
 *
 * The job data is available in ctx.request:
 * - ctx.request.body: The job payload
 * - ctx.request.headers: Job headers/metadata
 * - ctx.request.params.queue: The queue name
 * - ctx.request.params.jobId: Unique job ID
 * - ctx.request.params.attempt: Current attempt number (0-based)
 *
 * Additional metadata is available in ctx.vars._worker_job:
 * - id: Unique job ID
 * - queue: Queue name
 * - attempts: Current attempt number
 * - maxRetries: Maximum retry count
 * - priority: Job priority (if set)
 * - createdAt: When the job was created (ISO string)
 */
const step: Step = Workflow({
	name: "Process Background Job",
	version: "1.0.0",
	description: "Handles incoming worker jobs from the queue",
})
	.addTrigger("worker", {
		queue: "background-jobs",
	})
	.addStep({
		name: "process-job",
		node: "@blokjs/api-call",
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
	});

export default step;
