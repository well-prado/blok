import { BlokError, ErrorCategory, type NodeErrorPayload } from "@blokjs/shared";
import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";

/**
 * Mapping table from `@grpc/grpc-js` `status` codes to canonical
 * `(ErrorCategory, defaultHttpStatus)` pairs.
 *
 * Single source of truth for gRPC-side error classification. Adapters never
 * branch on status codes inline; they call {@link toBlokError} which uses
 * this table.
 *
 * The table is exhaustive — every gRPC status defined in
 * `@grpc/grpc-js#status` has an entry. CI verifies coverage in the unit test.
 */
export const GRPC_STATUS_MAP: Readonly<
	Record<GrpcStatus, { category: ErrorCategory; httpStatus: number; codePrefix: string }>
> = {
	[GrpcStatus.OK]: { category: ErrorCategory.INTERNAL, httpStatus: 200, codePrefix: "GRPC_OK" },
	[GrpcStatus.CANCELLED]: { category: ErrorCategory.CANCELLED, httpStatus: 499, codePrefix: "GRPC_CANCELLED" },
	[GrpcStatus.UNKNOWN]: { category: ErrorCategory.INTERNAL, httpStatus: 500, codePrefix: "GRPC_UNKNOWN" },
	[GrpcStatus.INVALID_ARGUMENT]: {
		category: ErrorCategory.VALIDATION,
		httpStatus: 400,
		codePrefix: "GRPC_INVALID_ARGUMENT",
	},
	[GrpcStatus.DEADLINE_EXCEEDED]: {
		category: ErrorCategory.TIMEOUT,
		httpStatus: 504,
		codePrefix: "GRPC_DEADLINE_EXCEEDED",
	},
	[GrpcStatus.NOT_FOUND]: { category: ErrorCategory.NOT_FOUND, httpStatus: 404, codePrefix: "GRPC_NOT_FOUND" },
	[GrpcStatus.ALREADY_EXISTS]: { category: ErrorCategory.CONFLICT, httpStatus: 409, codePrefix: "GRPC_ALREADY_EXISTS" },
	[GrpcStatus.PERMISSION_DENIED]: {
		category: ErrorCategory.PERMISSION,
		httpStatus: 403,
		codePrefix: "GRPC_PERMISSION_DENIED",
	},
	[GrpcStatus.RESOURCE_EXHAUSTED]: {
		category: ErrorCategory.RATE_LIMIT,
		httpStatus: 429,
		codePrefix: "GRPC_RESOURCE_EXHAUSTED",
	},
	[GrpcStatus.FAILED_PRECONDITION]: {
		category: ErrorCategory.CONFIGURATION,
		httpStatus: 412,
		codePrefix: "GRPC_FAILED_PRECONDITION",
	},
	[GrpcStatus.ABORTED]: { category: ErrorCategory.CONFLICT, httpStatus: 409, codePrefix: "GRPC_ABORTED" },
	[GrpcStatus.OUT_OF_RANGE]: { category: ErrorCategory.VALIDATION, httpStatus: 400, codePrefix: "GRPC_OUT_OF_RANGE" },
	[GrpcStatus.UNIMPLEMENTED]: { category: ErrorCategory.PROTOCOL, httpStatus: 501, codePrefix: "GRPC_UNIMPLEMENTED" },
	[GrpcStatus.INTERNAL]: { category: ErrorCategory.INTERNAL, httpStatus: 500, codePrefix: "GRPC_INTERNAL" },
	[GrpcStatus.UNAVAILABLE]: { category: ErrorCategory.DEPENDENCY, httpStatus: 503, codePrefix: "GRPC_UNAVAILABLE" },
	[GrpcStatus.DATA_LOSS]: { category: ErrorCategory.PROTOCOL, httpStatus: 500, codePrefix: "GRPC_DATA_LOSS" },
	[GrpcStatus.UNAUTHENTICATED]: {
		category: ErrorCategory.PERMISSION,
		httpStatus: 401,
		codePrefix: "GRPC_UNAUTHENTICATED",
	},
};

/**
 * Context passed alongside a gRPC error so the resulting {@link BlokError}
 * carries origin information (which SDK, which kind, which step) without
 * the adapter having to know the proto layout.
 */
export interface GrpcErrorContext {
	readonly node: string;
	readonly sdk: string;
	readonly sdkVersion: string;
	readonly runtimeKind: string;
}

/**
 * Convert a gRPC `ServiceError` (or any thrown value from a gRPC call) into a
 * canonical {@link BlokError}. Lossless when the SDK populates structured
 * details: gRPC `status.details` carrying a serialized {@link NodeErrorPayload}
 * is decoded and merged into the resulting error.
 *
 * Behavior:
 * - `ServiceError` with a known `code`: looked up in {@link GRPC_STATUS_MAP}.
 *   If `metadata` carries `blok-error-bin` (a serialized NodeErrorPayload),
 *   the payload is reconstructed via {@link BlokError.fromJSON} and the
 *   gRPC status only refines the http_status / category fallback.
 * - Plain `Error`: wrapped via {@link BlokError.fromUnknown}.
 * - Anything else: stringified and wrapped as `INTERNAL`.
 */
export function toBlokError(err: unknown, ctx: GrpcErrorContext): BlokError {
	if (err instanceof BlokError) return err;

	if (isServiceError(err)) {
		const payload = tryReadStructuredPayload(err);
		if (payload) {
			// SDK supplied a structured NodeError — round-trip it back into a
			// BlokError so all 19 fields survive intact.
			const rehydrated = BlokError.fromJSON(payload);
			// The gRPC status is the more authoritative source for code/category
			// fallback only when the payload didn't supply them. Since fromJSON
			// already restored category, we leave it alone.
			return rehydrated;
		}

		const mapping = GRPC_STATUS_MAP[err.code as GrpcStatus] ?? GRPC_STATUS_MAP[GrpcStatus.UNKNOWN];
		return BlokError[categoryFactoryName(mapping.category)]({
			code: mapping.codePrefix,
			message: err.details || err.message || `gRPC ${GrpcStatus[err.code]} from ${ctx.runtimeKind}`,
			httpStatus: mapping.httpStatus,
			node: ctx.node,
			sdk: ctx.sdk,
			sdkVersion: ctx.sdkVersion,
			runtimeKind: ctx.runtimeKind,
			details: { grpcStatus: GrpcStatus[err.code], grpcMessage: err.message },
		});
	}

	return BlokError.fromUnknown(err, ctx);
}

/**
 * Type guard for {@link ServiceError}. Duck-typed because `instanceof` checks
 * across `@grpc/grpc-js` module boundaries are unreliable when the dep is
 * deduped at multiple versions.
 */
export function isServiceError(err: unknown): err is ServiceError {
	return (
		!!err &&
		typeof err === "object" &&
		"code" in err &&
		typeof (err as { code: unknown }).code === "number" &&
		"details" in err
	);
}

/**
 * Read the `blok-error-bin` metadata key (if set) and parse it as a
 * {@link NodeErrorPayload}. Returns `null` if the key is absent or invalid.
 *
 * This is how SDKs propagate the full structured error: they put the
 * serialized payload into `Metadata.set("blok-error-bin", buffer)` and the
 * runner reads it here.
 */
function tryReadStructuredPayload(err: ServiceError): NodeErrorPayload | null {
	const metadata = err.metadata;
	if (!metadata) return null;
	const values = metadata.get("blok-error-bin");
	if (!values || values.length === 0) return null;
	const first = values[0];
	if (!(first instanceof Buffer)) return null;

	try {
		const parsed = JSON.parse(first.toString("utf-8"));
		if (parsed && typeof parsed === "object" && "code" in parsed && "category" in parsed) {
			return parsed as NodeErrorPayload;
		}
	} catch {
		/* malformed metadata — fall through to status-based mapping */
	}
	return null;
}

/**
 * Translate a `BlokError` produced by the runner side back into a gRPC status
 * code, for cases where the runner needs to report failure to a downstream
 * caller using gRPC. Inverse of {@link GRPC_STATUS_MAP}.
 *
 * Currently used only by tests; will be used by Phase 5 streaming when the
 * runner re-emits node errors as `ExecuteStream` `final` frames.
 */
export function categoryToGrpcStatus(category: ErrorCategory): GrpcStatus {
	for (const [statusKey, mapping] of Object.entries(GRPC_STATUS_MAP)) {
		if (mapping.category === category) {
			return Number(statusKey) as GrpcStatus;
		}
	}
	return GrpcStatus.INTERNAL;
}

/**
 * Map an {@link ErrorCategory} to its corresponding {@link BlokError} factory
 * method name. Single-source-of-truth for category → factory dispatch.
 */
function categoryFactoryName(category: ErrorCategory): keyof BlokErrorFactoryMethods {
	switch (category) {
		case ErrorCategory.VALIDATION:
			return "validation";
		case ErrorCategory.CONFIGURATION:
			return "configuration";
		case ErrorCategory.DEPENDENCY:
			return "dependency";
		case ErrorCategory.TIMEOUT:
			return "timeout";
		case ErrorCategory.PERMISSION:
			return "permission";
		case ErrorCategory.RATE_LIMIT:
			return "rateLimit";
		case ErrorCategory.NOT_FOUND:
			return "notFound";
		case ErrorCategory.CONFLICT:
			return "conflict";
		case ErrorCategory.CANCELLED:
			return "cancelled";
		case ErrorCategory.INTERNAL:
			return "internal";
		case ErrorCategory.PROTOCOL:
			return "protocol";
		case ErrorCategory.DATA:
			return "data";
		default:
			return "internal";
	}
}

/** Compile-time check that all `BlokError` factories are accounted for. */
type BlokErrorFactoryMethods = {
	validation: typeof BlokError.validation;
	configuration: typeof BlokError.configuration;
	dependency: typeof BlokError.dependency;
	timeout: typeof BlokError.timeout;
	permission: typeof BlokError.permission;
	rateLimit: typeof BlokError.rateLimit;
	notFound: typeof BlokError.notFound;
	conflict: typeof BlokError.conflict;
	cancelled: typeof BlokError.cancelled;
	internal: typeof BlokError.internal;
	protocol: typeof BlokError.protocol;
	data: typeof BlokError.data;
};
