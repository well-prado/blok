import { defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { z } from "zod";

/**
 * Emit a log line at the given level via ctx.logger. Returns the
 * level + message echoed (mainly for chaining and Studio inspection).
 *
 * Routes through the runner's `LoggerContext.logLevel(level, message)`
 * when available; falls back to plain `.log(message)` otherwise. The
 * `error` level uses `LoggerContext.error(message, stack)` directly so
 * the trace store sees the proper severity.
 */
export default defineNode({
	name: "@blokjs/log",
	description: "Emit a log line at level: info | warn | error | debug.",
	input: z.object({
		level: z.enum(["info", "warn", "error", "debug"]),
		message: z.string(),
		attrs: z.record(z.string(), z.unknown()).optional(),
	}),
	output: z.object({
		level: z.string(),
		message: z.string(),
	}),

	async execute(ctx: Context, input) {
		const logger = ctx.logger;
		const text = input.attrs ? `${input.message} ${JSON.stringify(input.attrs)}` : input.message;
		if (input.level === "error") {
			logger.error?.(text, "");
		} else if (typeof logger.logLevel === "function") {
			logger.logLevel(input.level, text);
		} else {
			logger.log?.(text);
		}
		return { level: input.level, message: input.message };
	},
});
