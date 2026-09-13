/**
 * Canonical `NodeError` envelope for the JavaScript worker.
 *
 * Every other SDK builds this same shape by hand from its own error type; the
 * JavaScript side has one extra source to fold in — `GlobalError`, which
 * `defineNode`'s `handle()` already produces for Zod validation failures and
 * for anything an author throws. So this module's job is narrow: turn
 * `GlobalError | Error | unknown` into the seven required proto fields plus the
 * strongly-encouraged ones.
 */

import { GlobalError } from "@blokjs/shared";

/** Proto `ErrorCategory` enum names (`enums: String` on both ends). */
export type ErrorCategoryName =
	| "VALIDATION"
	| "CONFIGURATION"
	| "DEPENDENCY"
	| "TIMEOUT"
	| "PERMISSION"
	| "RATE_LIMIT"
	| "NOT_FOUND"
	| "CONFLICT"
	| "CANCELLED"
	| "INTERNAL"
	| "PROTOCOL"
	| "DATA";

export interface NodeErrorEnvelope {
	code: string;
	category: ErrorCategoryName;
	severity: "ERROR";
	node: string;
	sdk: string;
	sdkVersion: string;
	runtimeKind: string;
	at: { seconds: number; nanos: number };
	message: string;
	description: string;
	remediation: string;
	docUrl: string;
	causes: never[];
	stack: string;
	contextSnapshotJson: Buffer;
	httpStatus: number;
	retryable: boolean;
	retryAfterMs: number;
	detailsJson: Buffer;
}

export interface ErrorOrigin {
	node: string;
	sdk: string;
	sdkVersion: string;
	runtimeKind: string;
}

/** An error the worker itself raises, with a pre-decided classification. */
export class WorkerError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly category: ErrorCategoryName,
		readonly httpStatus: number,
		readonly retryable = false,
		readonly remediation = "",
	) {
		super(message);
		this.name = code;
	}
}

/** `GlobalError.context.code` is an HTTP status; map it to a proto category. */
function categoryForHttpStatus(status: number): ErrorCategoryName {
	if (status === 400 || status === 422) return "VALIDATION";
	if (status === 401 || status === 403) return "PERMISSION";
	if (status === 404) return "NOT_FOUND";
	if (status === 409) return "CONFLICT";
	if (status === 413) return "DATA";
	if (status === 429) return "RATE_LIMIT";
	if (status === 504) return "TIMEOUT";
	if (status >= 500) return "INTERNAL";
	return "INTERNAL";
}

/** `ErrorContext.message` is `string | string[]`; the envelope wants one line. */
function flatten(message: string | string[] | undefined): string {
	return Array.isArray(message) ? message.join("; ") : (message ?? "");
}

function timestamp(): { seconds: number; nanos: number } {
	const now = Date.now();
	return { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1_000_000 };
}

function jsonBytes(value: unknown): Buffer {
	if (value === undefined || value === null) return Buffer.alloc(0);
	try {
		return Buffer.from(JSON.stringify(value), "utf8");
	} catch {
		return Buffer.alloc(0);
	}
}

/**
 * Map anything thrown (or any `GlobalError` a node returned on its response)
 * into the canonical envelope.
 */
export function toNodeError(error: unknown, origin: ErrorOrigin): NodeErrorEnvelope {
	const base = {
		severity: "ERROR" as const,
		node: origin.node,
		sdk: origin.sdk,
		sdkVersion: origin.sdkVersion,
		runtimeKind: origin.runtimeKind,
		at: timestamp(),
		docUrl: "",
		causes: [] as never[],
		contextSnapshotJson: Buffer.alloc(0),
		retryAfterMs: 0,
	};

	if (error instanceof WorkerError) {
		return {
			...base,
			code: error.code,
			category: error.category,
			message: error.message,
			description: "",
			remediation: error.remediation,
			stack: error.stack ?? "",
			httpStatus: error.httpStatus,
			retryable: error.retryable,
			detailsJson: Buffer.alloc(0),
		};
	}

	if (error instanceof GlobalError) {
		const httpStatus = error.context.code ?? 500;
		const category = categoryForHttpStatus(httpStatus);
		return {
			...base,
			code: category === "VALIDATION" ? "NODE_INPUT_VALIDATION_FAILED" : "NODE_EXECUTION_FAILED",
			category,
			message: flatten(error.context.message) || error.message || "Node execution failed",
			// `json` carries `validation_errors` for a Zod failure — the most
			// useful debugging context the JS side has, so it rides along in
			// `details_json` rather than being flattened into the message.
			description: "",
			remediation:
				category === "VALIDATION"
					? "Check the step inputs against the node's Zod input schema (see the validation_errors detail)."
					: "",
			stack: error.context.stack ?? error.stack ?? "",
			httpStatus,
			retryable: httpStatus >= 500 && httpStatus !== 501,
			detailsJson: jsonBytes(error.context.json),
		};
	}

	if (error instanceof Error) {
		return {
			...base,
			code: "NODE_EXECUTION_FAILED",
			category: "INTERNAL",
			message: error.message || "Node execution failed",
			description: "",
			remediation: "",
			stack: error.stack ?? "",
			httpStatus: 500,
			retryable: true,
			detailsJson: Buffer.alloc(0),
		};
	}

	return {
		...base,
		code: "NODE_EXECUTION_FAILED",
		category: "INTERNAL",
		message: String(error),
		description: "",
		remediation: "",
		stack: "",
		httpStatus: 500,
		retryable: false,
		detailsJson: Buffer.alloc(0),
	};
}
