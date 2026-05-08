import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Append an audit event to a process-wide ring buffer. Returns the
 * event with a server-side timestamp for chaining.
 *
 * The ring is bounded at 1000 entries (oldest dropped) to bound memory
 * use. For real audit trails plug an external store (Postgres, S3,
 * audit service) — this helper is the development/test stand-in.
 *
 * Inspect via the exported `getAuditEvents()` (test-only) or via the
 * GET /__blok/audit endpoint added by the trigger when wired.
 */
export interface AuditEvent {
	event: string;
	attrs?: Record<string, unknown>;
	timestamp: number;
	requestId?: string;
}

const MAX_AUDIT_RING = 1000;
const ring: AuditEvent[] = [];

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
