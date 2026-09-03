import type { ModelAdapter, ModelRequest, ModelStreamChunk } from "../contracts";
import { AgentKernelError, parseModelStreamChunk } from "../contracts";

export interface AdapterContractCase {
	readonly name: string;
	readonly run: () => Promise<void>;
}

const request: ModelRequest = {
	contractVersion: "1",
	idempotencyKey: "contract-test:request",
	model: "contract-test",
	messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	tools: [],
};

async function collect(adapter: ModelAdapter): Promise<readonly ModelStreamChunk[]> {
	const chunks: ModelStreamChunk[] = [];
	for await (const chunk of adapter.stream(request)) chunks.push(parseModelStreamChunk(chunk));
	return chunks;
}

/**
 * Provider-independent assertions shared by fake and production adapters.
 * The caller can feed the returned cases into its test runner (Vitest,
 * Node's test runner, or a downstream provider package).
 */
export function adapterContractSuite(factory: () => ModelAdapter): readonly AdapterContractCase[] {
	return [
		{
			name: "emits valid chunks for a request",
			run: async () => {
				const chunks = await collect(factory());
				if (chunks.length === 0) throw new AgentKernelError("INVALID_CONTRACT", "adapter emitted no chunks");
			},
		},
		{
			name: "does not mutate the request",
			run: async () => {
				const before = JSON.stringify(request);
				await collect(factory());
				if (JSON.stringify(request) !== before)
					throw new AgentKernelError("INVALID_CONTRACT", "adapter mutated the request");
			},
		},
	];
}
