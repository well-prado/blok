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
	async handle(_ctx: Context, _inputs: InputType): Promise<INanoServiceResponse> {
		const response = new NanoServiceResponse();

		const entry = {
			language: "nodejs",
			order: 1,
			timestamp: new Date().toISOString(),
		};

		response.setSuccess({
			chain: [entry],
			origin: "blok-cross-runtime-test",
		} as unknown as JsonLikeObject);

		return response;
	}
}
