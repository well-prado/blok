import type { ModelAdapter, ModelRequest, ModelStreamChunk } from "../contracts";

export type FakeResponse = readonly ModelStreamChunk[];
export type FakeResponseFactory = (request: ModelRequest, callNumber: number) => FakeResponse | Promise<FakeResponse>;

/** A deterministic adapter for kernel and adapter-contract tests. */
export class FakeModelAdapter implements ModelAdapter {
	readonly name = "fake";
	private callCount = 0;
	private readonly factory: FakeResponseFactory;

	constructor(responses: readonly FakeResponse[] | FakeResponseFactory) {
		this.factory =
			typeof responses === "function"
				? responses
				: (_request, callNumber) => responses[callNumber] ?? responses.at(-1) ?? [];
	}

	get calls(): number {
		return this.callCount;
	}

	stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
		const callNumber = this.callCount;
		this.callCount += 1;
		const factory = this.factory;
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<ModelStreamChunk> {
				const response = await factory(request, callNumber);
				for (const chunk of response) yield chunk;
			},
		};
	}
}

export function textResponse(text: string, index = 0): FakeResponse {
	return [
		{ kind: "text-delta", index, text },
		{ kind: "finish", index: index + 1, reason: "stop" },
	];
}

export function toolResponse(
	call: { readonly id: string; readonly name: string; readonly arguments: string },
	startIndex = 0,
): FakeResponse {
	return [
		{
			kind: "tool-call-delta",
			index: startIndex,
			callId: call.id,
			name: call.name,
			argumentsDelta: call.arguments,
		},
		{ kind: "finish", index: startIndex + 1, reason: "tool-call" },
	];
}
