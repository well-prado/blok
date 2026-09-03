import type { GraphErrorCategory } from "@blokjs/shared";

export class GraphProviderError extends Error {
	readonly code: string;
	readonly category: GraphErrorCategory;
	readonly retryable: boolean;
	readonly guidance: "reread-authoritative-source" | "retry" | "narrow-query" | "inspect-provider" | "none";

	constructor(
		category: GraphErrorCategory,
		code: string,
		message: string,
		options: {
			retryable?: boolean;
			guidance?: "reread-authoritative-source" | "retry" | "narrow-query" | "inspect-provider" | "none";
		} = {},
	) {
		super(message);
		this.name = "GraphProviderError";
		this.category = category;
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.guidance = options.guidance ?? "none";
	}

	static cancelled(): GraphProviderError {
		return new GraphProviderError("cancelled", "GRAPH_CANCELLED", "Graph operation was cancelled", {
			retryable: true,
			guidance: "retry",
		});
	}
}
