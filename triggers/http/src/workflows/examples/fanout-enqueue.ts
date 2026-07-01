import { http, forEach, js, node, step, workflow } from "@blokjs/core";
import type { Handle } from "@blokjs/core";

export default workflow(
	"fanout-enqueue",
	{
		version: "1.0.0",
		description:
			"v0.6.10 — Fan-out producer. POST `{items:[...], tenantId?: '...'}` and each item gets enqueued as a separate worker job on queue `fanout-jobs`. The forEach uses `mode: parallel + concurrency: 5` so 1000 items don't serialize 1000 RPCs. Each enqueue uses `dedupId: <tenantId>:<itemId>` so accidental re-submission of the same set is a no-op (BullMQ/NATS/SQS-level dedup, NOT workflow-step idempotency). Set BLOK_WORKER_ADAPTER=nats/redis/bullmq + the matching connection env vars when deploying; in-memory adapter works for single-process dev. Needs --triggers http,worker --examples at scaffold time.",
		trigger: http.post("/fanout/jobs", { accept: "application/json" }),
	},
	(req) => {
		const body = req.body as Handle<{
			items: { id: unknown }[];
			tenantId: unknown;
		}>;
		forEach(
			body.items,
			(item, index) => {
				step("enqueue", node("@blokjs/worker-publish"), {
					queue: "fanout-jobs",
					payload: {
						item,
						index,
						tenantId: js`${body.tenantId} || 'default'`,
						enqueuedAt: js`Date.now()`,
					},
					dedupId: js`\`$\{${body.tenantId} || 'default'}:$\{${item} && ${item}.id ? ${item}.id : ${index}}\``,
				});
			},
			{ id: "fan-out", as: "item", mode: "parallel", concurrency: 5 },
		);
		step("respond", node("@blokjs/expr"), {
			expression:
				"({ ok: true, queued: (ctx.state['fan-out'] || []).length, tenantId: ctx.request.body.tenantId || 'default', jobIds: (ctx.state['fan-out'] || []).map(r => r && r.data && r.data.jobId).filter(Boolean) })",
		});
	},
);
