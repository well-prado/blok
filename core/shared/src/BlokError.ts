import GlobalError from "./GlobalError";

/**
 * The categories every Blok node error falls into.
 *
 * Mirror of the proto `blok.runtime.v1.ErrorCategory` enum. Stored as string
 * values so JSON payloads (e.g. `GlobalError.context.json`) are human-readable.
 */
export const ErrorCategory = {
	VALIDATION: "VALIDATION",
	CONFIGURATION: "CONFIGURATION",
	DEPENDENCY: "DEPENDENCY",
	TIMEOUT: "TIMEOUT",
	PERMISSION: "PERMISSION",
	RATE_LIMIT: "RATE_LIMIT",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	CANCELLED: "CANCELLED",
	INTERNAL: "INTERNAL",
	PROTOCOL: "PROTOCOL",
	DATA: "DATA",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/** How severe an error is. Default for thrown errors is `ERROR`. */
export const ErrorSeverity = {
	INFO: "INFO",
	WARN: "WARN",
	ERROR: "ERROR",
	FATAL: "FATAL",
} as const;

export type ErrorSeverity = (typeof ErrorSeverity)[keyof typeof ErrorSeverity];

/**
 * Default HTTP status per error category.
 *
 * Single source of truth — the runner uses these on `GlobalError.context.code`
 * and HTTP triggers use them as the response status. Override per-error via
 * `BlokErrorOpts.httpStatus`.
 */
export const DEFAULT_HTTP_STATUS: Readonly<Record<ErrorCategory, number>> = {
	VALIDATION: 400,
	CONFIGURATION: 500,
	DEPENDENCY: 502,
	TIMEOUT: 504,
	PERMISSION: 403,
	RATE_LIMIT: 429,
	NOT_FOUND: 404,
	CONFLICT: 409,
	CANCELLED: 499,
	INTERNAL: 500,
	PROTOCOL: 502,
	DATA: 422,
};

/** Default retryable hint per error category. */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorCategory, boolean>> = {
	VALIDATION: false,
	CONFIGURATION: false,
	DEPENDENCY: true,
	TIMEOUT: true,
	PERMISSION: false,
	RATE_LIMIT: true,
	NOT_FOUND: false,
	CONFLICT: false,
	CANCELLED: false,
	INTERNAL: false,
	PROTOCOL: false,
	DATA: false,
};

/**
 * The plain-data shape of a Blok node error.
 *
 * 1:1 mirror of the proto `blok.runtime.v1.NodeError` message in JSON form.
 * The runner-side gRPC codec converts between this shape and the proto type;
 * this module has no gRPC dependency.
 */
export interface NodeErrorPayload {
	/** Stable machine identifier — see `docs/error-codes.md`. */
	code: string;
	category: ErrorCategory;
	severity: ErrorSeverity;
	/** Node name that produced this error (auto-filled by SDKs). */
	node: string;
	/** SDK identifier, e.g. "blok-python3" (auto-filled). */
	sdk: string;
	sdkVersion: string;
	/** Runtime kind, e.g. "runtime.python3" (auto-filled). */
	runtimeKind: string;
	/** ISO 8601 timestamp of the error. */
	at: string;
	message: string;
	description: string;
	remediation: string;
	docUrl: string;
	/** Flattened cause chain — outermost cause first. */
	causes: NodeErrorPayload[];
	stack: string;
	/** Bounded slice of resolved inputs/state at error time. */
	contextSnapshot: unknown;
	httpStatus: number;
	retryable: boolean;
	retryAfterMs: number;
	/** Category-specific structured details (Zod issues, SQL state, etc.). */
	details: unknown;
}

/**
 * Constructor options for {@link BlokError}.
 *
 * `code`, `message`, and the implicit `category` (via the factory method) are
 * the seven required fields that, combined with auto-filled origin, make every
 * error self-describing.
 */
export interface BlokErrorOpts {
	/** Stable machine identifier (e.g. "POSTGRES_CONNECT_TIMEOUT"). */
	code: string;
	/** One-sentence human summary. */
	message: string;
	/** Multi-paragraph context: what was tried, why it failed. */
	description?: string;
	/** Suggested next step for the developer. */
	remediation?: string;
	/** Optional link to documentation explaining this code. */
	docUrl?: string;
	/** Underlying cause — any Error or BlokError. */
	cause?: Error | BlokError;
	/** Override default retryable hint. */
	retryable?: boolean;
	/** Suggested wait time before retrying. */
	retryAfterMs?: number;
	/** Category-specific structured details. */
	details?: unknown;
	/** Bounded slice of inputs/state at error time. */
	contextSnapshot?: unknown;
	/** Override the default HTTP status for this category. */
	httpStatus?: number;
	/** Override the default severity (`ERROR`). */
	severity?: ErrorSeverity;
	/** Override the auto-filled node name. */
	node?: string;
	/** Override the auto-filled SDK name. */
	sdk?: string;
	/** Override the auto-filled SDK version. */
	sdkVersion?: string;
	/** Override the auto-filled runtime kind. */
	runtimeKind?: string;
}

/**
 * Structured error type for Blok nodes. Extends {@link GlobalError} so it
 * remains fully compatible with existing `instanceof GlobalError` checks and
 * `GlobalError.context` consumers (HTTP trigger, RunTracker, Studio).
 *
 * Use the static factory methods (`BlokError.validation`,
 * `BlokError.dependency`, etc.) — direct construction is private.
 *
 * Auto-fills `name`, `stack`, and `at`. The runner enriches `node`, `sdk`,
 * `sdkVersion`, and `runtimeKind` when the error is sourced from a runtime
 * adapter; module nodes can override via {@link BlokErrorOpts}.
 *
 * @example
 *   throw BlokError.dependency({
 *     code: "POSTGRES_CONNECT_TIMEOUT",
 *     message: "Could not connect to Postgres within 5s",
 *     description: `Tried host=${host} port=${port}; timeout=${dur}ms`,
 *     remediation: "Check DATABASE_URL env var and network reachability",
 *     cause: err,
 *   });
 */
export default class BlokError extends GlobalError {
	readonly category: ErrorCategory;
	readonly severity: ErrorSeverity;
	readonly errorCode: string;
	readonly description: string;
	readonly remediation: string;
	readonly docUrl: string;
	readonly retryable: boolean;
	readonly retryAfterMs: number;
	readonly details: unknown;
	readonly contextSnapshot: unknown;
	readonly causes: ReadonlyArray<NodeErrorPayload>;
	readonly at: Date;
	readonly sdk: string;
	readonly sdkVersion: string;
	readonly runtimeKind: string;
	readonly httpStatus: number;
	readonly nodeName: string;

	private constructor(category: ErrorCategory, opts: BlokErrorOpts) {
		super(opts.message);
		Object.setPrototypeOf(this, BlokError.prototype);

		this.category = category;
		this.severity = opts.severity ?? ErrorSeverity.ERROR;
		this.errorCode = opts.code;
		this.description = opts.description ?? "";
		this.remediation = opts.remediation ?? "";
		this.docUrl = opts.docUrl ?? "";
		this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[category];
		this.retryAfterMs = opts.retryAfterMs ?? 0;
		this.details = opts.details ?? null;
		this.contextSnapshot = opts.contextSnapshot ?? null;
		this.at = new Date();
		this.sdk = opts.sdk ?? "";
		this.sdkVersion = opts.sdkVersion ?? "";
		this.runtimeKind = opts.runtimeKind ?? "";
		this.nodeName = opts.node ?? "";
		this.httpStatus = opts.httpStatus ?? DEFAULT_HTTP_STATUS[category];

		this.causes = opts.cause ? Object.freeze(BlokError.flattenCauses(opts.cause)) : Object.freeze([]);

		// Populate the GlobalError.context fields so legacy consumers keep working.
		this.setCode(this.httpStatus);
		this.setName(this.nodeName);
		this.setStack(this.stack);
		this.setJson(this.toJSON() as unknown as Record<string, unknown>);
	}

	// =========================================================================
	// Factory methods (one per category)
	// =========================================================================

	static validation(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.VALIDATION, opts);
	}
	static configuration(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.CONFIGURATION, opts);
	}
	static dependency(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.DEPENDENCY, opts);
	}
	static timeout(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.TIMEOUT, opts);
	}
	static permission(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.PERMISSION, opts);
	}
	static rateLimit(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.RATE_LIMIT, opts);
	}
	static notFound(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.NOT_FOUND, opts);
	}
	static conflict(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.CONFLICT, opts);
	}
	static cancelled(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.CANCELLED, opts);
	}
	static internal(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.INTERNAL, opts);
	}
	static protocol(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.PROTOCOL, opts);
	}
	static data(opts: BlokErrorOpts): BlokError {
		return new BlokError(ErrorCategory.DATA, opts);
	}

	// =========================================================================
	// Conversion
	// =========================================================================

	/**
	 * Convert any thrown value into a `BlokError`.
	 *
	 * Used by the runner's auto-wrap layer so legacy code (`throw new
	 * Error("oops")`) still produces a structured error. Categorization is
	 * heuristic — recognizes existing `BlokError` (passthrough), `GlobalError`
	 * (preserves code/json), `Error` (wraps as `INTERNAL`), and anything else
	 * (stringified as `INTERNAL`).
	 */
	static fromUnknown(
		err: unknown,
		ctx?: { node?: string; sdk?: string; sdkVersion?: string; runtimeKind?: string },
	): BlokError {
		if (err instanceof BlokError) {
			return err;
		}

		if (err instanceof GlobalError) {
			const httpStatus = (err.context.code as number | undefined) ?? 500;
			const wrapped = new BlokError(ErrorCategory.INTERNAL, {
				code: "GLOBAL_ERROR",
				message: err.message ?? "Unknown error",
				details: err.context.json ?? null,
				httpStatus,
				node: ctx?.node ?? (err.context.name as string | undefined) ?? "",
				sdk: ctx?.sdk,
				sdkVersion: ctx?.sdkVersion,
				runtimeKind: ctx?.runtimeKind,
			});
			if (err.stack) wrapped.setStack(err.stack);
			return wrapped;
		}

		if (err instanceof Error) {
			return new BlokError(ErrorCategory.INTERNAL, {
				code: `UNCAUGHT_${err.name || "ERROR"}`.toUpperCase(),
				message: err.message || "Uncaught error",
				cause: err,
				node: ctx?.node,
				sdk: ctx?.sdk,
				sdkVersion: ctx?.sdkVersion,
				runtimeKind: ctx?.runtimeKind,
			});
		}

		return new BlokError(ErrorCategory.INTERNAL, {
			code: "UNCAUGHT_ERROR",
			message: typeof err === "string" ? err : JSON.stringify(err),
			node: ctx?.node,
			sdk: ctx?.sdk,
			sdkVersion: ctx?.sdkVersion,
			runtimeKind: ctx?.runtimeKind,
		});
	}

	/**
	 * Reconstruct a `BlokError` from a serialized {@link NodeErrorPayload}.
	 *
	 * Used by the runner's gRPC codec to convert proto `NodeError` messages
	 * received from SDKs back into TS-side errors.
	 */
	static fromJSON(payload: NodeErrorPayload): BlokError {
		const err = new BlokError(payload.category, {
			code: payload.code,
			message: payload.message,
			description: payload.description,
			remediation: payload.remediation,
			docUrl: payload.docUrl,
			retryable: payload.retryable,
			retryAfterMs: payload.retryAfterMs,
			details: payload.details,
			contextSnapshot: payload.contextSnapshot,
			httpStatus: payload.httpStatus,
			severity: payload.severity,
			node: payload.node,
			sdk: payload.sdk,
			sdkVersion: payload.sdkVersion,
			runtimeKind: payload.runtimeKind,
		});

		if (payload.stack) err.setStack(payload.stack);
		// Restore frozen causes from payload (causes are NodeErrorPayload[], not BlokError).
		(err as { causes: ReadonlyArray<NodeErrorPayload> }).causes = Object.freeze([...payload.causes]);
		return err;
	}

	/** Serialize to the canonical {@link NodeErrorPayload} shape (matches proto wire format). */
	toJSON(): NodeErrorPayload {
		return {
			code: this.errorCode,
			category: this.category,
			severity: this.severity,
			node: this.nodeName,
			sdk: this.sdk,
			sdkVersion: this.sdkVersion,
			runtimeKind: this.runtimeKind,
			at: this.at.toISOString(),
			message: this.message,
			description: this.description,
			remediation: this.remediation,
			docUrl: this.docUrl,
			causes: [...this.causes],
			stack: this.stack ?? "",
			contextSnapshot: this.contextSnapshot,
			httpStatus: this.httpStatus,
			retryable: this.retryable,
			retryAfterMs: this.retryAfterMs,
			details: this.details,
		};
	}

	// =========================================================================
	// Internal helpers
	// =========================================================================

	private static flattenCauses(cause: Error | BlokError): NodeErrorPayload[] {
		const causes: NodeErrorPayload[] = [];
		let current: Error | BlokError | undefined = cause;
		const visited = new Set<unknown>();
		while (current && !visited.has(current)) {
			visited.add(current);

			if (current instanceof BlokError) {
				// Append the BlokError's own payload (with `causes` zeroed out so we
				// don't double-count) followed by its already-flattened causes. This
				// keeps the final chain flat regardless of how deeply nested the
				// caller's BlokError-as-cause chain was.
				causes.push(BlokError.causeToPayload(current));
				causes.push(...current.causes);
				break;
			}

			causes.push(BlokError.causeToPayload(current));
			const nextCause: Error | BlokError | undefined = (current as { cause?: Error | BlokError }).cause;
			current = nextCause;
		}
		return causes;
	}

	private static causeToPayload(cause: Error | BlokError): NodeErrorPayload {
		if (cause instanceof BlokError) {
			// Strip the cause's own `causes` to avoid duplication — the caller
			// (flattenCauses) appends them separately to keep the final list flat.
			return { ...cause.toJSON(), causes: [] };
		}

		return {
			code: `UNCAUGHT_${cause.name || "ERROR"}`.toUpperCase(),
			category: ErrorCategory.INTERNAL,
			severity: ErrorSeverity.ERROR,
			node: "",
			sdk: "",
			sdkVersion: "",
			runtimeKind: "",
			at: new Date().toISOString(),
			message: cause.message || "Uncaught error",
			description: "",
			remediation: "",
			docUrl: "",
			causes: [],
			stack: cause.stack ?? "",
			contextSnapshot: null,
			httpStatus: 500,
			retryable: false,
			retryAfterMs: 0,
			details: null,
		};
	}
}
