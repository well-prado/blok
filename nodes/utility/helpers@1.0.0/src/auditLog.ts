import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Append an audit event to a process-wide, in-memory ring buffer. Returns
 * the event with a server-side timestamp for chaining.
 *
 * ⚠️ NOT DURABLE. The ring is bounded at 1000 entries (oldest silently
 * dropped) and lives only in this process's memory — it is cleared on every
 * restart and is invisible across replicas. It is a development/test
 * stand-in, NOT a compliance audit log. For real audit trails write to an
 * external store (Postgres, S3, an audit service) from your own node.
 *
 * Inspect the buffer via the exported `getAuditEvents()` (test/dev only).
 * (There is no `/__blok/audit` HTTP endpoint — that was never implemented.)
 */
export interface AuditEvent {
	event: string;
	attrs?: Record<string, unknown>;
	timestamp: number;
	requestId?: string;
}

const MAX_AUDIT_RING = 1000;
const ring: AuditEvent[] = [];

// Warn once, in production only, so operators don't mistake this dev/test
// helper for a durable audit trail. Gated to production to avoid noise in
// tests and local dev.
let warnedEphemeral = false;

export function getAuditEvents(): readonly AuditEvent[] {
	return ring;
}

export function _resetAuditEventsForTests(): void {
	ring.length = 0;
}

export default defineNode({
	name: "@blokjs/audit-log",
	description: "Append an event to the in-memory audit ring (bounded at 1000 entries).",
	input: z.object({
		event: z.string().min(1),
		attrs: z.record(z.string(), z.unknown()).optional(),
	}),
	output: z.object({
		event: z.string(),
		attrs: z.record(z.string(), z.unknown()).optional(),
		timestamp: z.number(),
		requestId: z.string().optional(),
	}),

	async execute(ctx, input) {
		if (!warnedEphemeral && process.env.NODE_ENV === "production") {
			warnedEphemeral = true;
			console.warn(
				"[blok][@blokjs/audit-log] Events are stored in an in-memory ring buffer (max 1000, cleared on restart, per-process). This is NOT a durable audit trail — write to an external store for compliance.",
			);
		}
		const ev: AuditEvent = {
			event: input.event,
			attrs: input.attrs,
			timestamp: Date.now(),
			requestId: ctx.id,
		};
		ring.push(ev);
		while (ring.length > MAX_AUDIT_RING) ring.shift();
		return ev;
	},
});
