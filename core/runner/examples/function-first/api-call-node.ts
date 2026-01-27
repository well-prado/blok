/**
 * Example: API Call Node (Function-First)
 *
 * This reimagines the existing @nanoservice-ts/api-call node using
 * the function-first pattern. Notice how much simpler it is!
 *
 * Old class-based version: ~150 lines
 * New function-first version: ~40 lines
 */

import type { Context } from "@nanoservice-ts/shared";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";

export default defineNode({
	name: "api-call",
	description: "Makes HTTP API calls with automatic JSON handling",

	input: z.object({
		url: z.string().url("Must be a valid URL"),
		method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
		headers: z.record(z.string()).optional(),
		body: z.any().optional(),
		timeout: z.number().positive().optional().default(30000),
	}),

	output: z.object({
		status: z.number().int().min(100).max(599),
		statusText: z.string(),
		data: z.any(),
		headers: z.record(z.string()),
		duration: z.number(),
	}),

	async execute(ctx, input) {
		const startTime = performance.now();

		ctx.logger.log(`Making ${input.method} request to ${input.url}`);

		// Make the API call
		const response = await fetch(input.url, {
			method: input.method,
			headers: {
				"Content-Type": "application/json",
				...input.headers,
			},
			body: input.body ? JSON.stringify(input.body) : undefined,
			signal: AbortSignal.timeout(input.timeout),
		});

		// Parse response
		const contentType = response.headers.get("content-type") || "";
		let data: unknown;

		if (contentType.includes("application/json")) {
			data = await response.json();
		} else {
			data = await response.text();
		}

		const duration = performance.now() - startTime;

		ctx.logger.log(`Request completed in ${duration.toFixed(2)}ms with status ${response.status}`);

		// Store response in context for downstream nodes
		if (ctx.vars) {
			ctx.vars["api-response"] = { status: response.status, data };
		}

		return {
			status: response.status,
			statusText: response.statusText,
			data,
			headers: Object.fromEntries(response.headers.entries()),
			duration,
		};
	},
});
