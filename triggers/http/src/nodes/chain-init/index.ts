import {
	type INanoServiceResponse,
	type JsonLikeObject,
	NanoService,
	NanoServiceResponse,
} from "@nanoservice-ts/runner";
import type { Context } from "@nanoservice-ts/shared";

type InputType = Record<string, never>;

/**
 * ChainInit node — starts a cross-runtime chain test.
 *
 * Initializes the chain data structure with the first entry (nodejs)
 * so downstream nodes in other languages can append to it.
 */
export default class ChainInit extends NanoService<InputType> {
	async handle(ctx: Context, _inputs: InputType): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();

		const entry = {
			language: "nodejs",
			order: 1,
			timestamp: new Date().toISOString(),
		};

		const data = {
			chain: [entry],
			origin: "blok-cross-runtime-test",
		};

		// Store in ctx.vars so downstream nodes can access via ctx.vars['init']
		if (!ctx.vars) {
			(ctx as Record<string, unknown>).vars = {};
		}
		(ctx.vars as Record<string, unknown>).init = data;

		response.setSuccess(data as unknown as JsonLikeObject);

		return response;
	}
}
