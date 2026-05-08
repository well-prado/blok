import { defineNode } from "@blokjs/runner";
import { metrics } from "@opentelemetry/api";
import { z } from "zod";

/**
 * Emit an OpenTelemetry counter for `event`. No-op cleanly when no
 * exporter is wired (the OTel API tolerates missing implementations).
 *
 * For event:value emission of arbitrary numeric metrics, set `value`.
 * Default behavior is to increment the counter by 1.
 */
export default defineNode({
	name: "@blokjs/metrics-emit",
	description: "Emit an OTel counter for `event`. No-op when no exporter is configured.",
	input: z.object({
		event: z.string().min(1),
		value: z.number().default(1),
		attrs: z.record(z.string(), z.unknown()).optional(),
	}),
	output: z.object({
		event: z.string(),
		value: z.number(),
	}),

	async execute(_ctx, input) {
		const meter = metrics.getMeter("blok-helpers");
		const counter = meter.createCounter("blok_event_total", {
			description: "Custom event counter emitted via @blokjs/metrics-emit",
		});
		const stringAttrs: Record<string, string> = { event: input.event };
		if (input.attrs) {
			for (const [k, v] of Object.entries(input.attrs)) {
				stringAttrs[k] = typeof v === "string" ? v : JSON.stringify(v);
			}
		}
		counter.add(input.value, stringAttrs);
		return { event: input.event, value: input.value };
	},
});
