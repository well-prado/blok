import { BlokError, ErrorCategory } from "@blokjs/shared";
import { status as GrpcStatus, Metadata } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import {
	GRPC_STATUS_MAP,
	type GrpcErrorContext,
	categoryToGrpcStatus,
	isServiceError,
	toBlokError,
} from "../../../../src/adapters/grpc/GrpcErrors";

const ctx: GrpcErrorContext = {
	node: "test-node",
	sdk: "blok-python3",
	sdkVersion: "1.0.0",
	runtimeKind: "runtime.python3",
};

function makeServiceError(
	code: GrpcStatus,
	details = "test",
	metadata?: Metadata,
): Error & {
	code: GrpcStatus;
	details: string;
	metadata: Metadata;
} {
	const md = metadata ?? new Metadata();
	const err = Object.assign(new Error(`gRPC ${code}`), {
		code,
		details,
		metadata: md,
	});
	return err;
}

describe("GRPC_STATUS_MAP", () => {
	it("has an entry for every gRPC status code", () => {
		const allStatuses = Object.values(GrpcStatus).filter((v): v is GrpcStatus => typeof v === "number");
		for (const code of allStatuses) {
			expect(GRPC_STATUS_MAP).toHaveProperty(String(code));
			const entry = GRPC_STATUS_MAP[code];
			expect(entry.category).toBeDefined();
			expect(typeof entry.httpStatus).toBe("number");
			expect(typeof entry.codePrefix).toBe("string");
		}
	});

	it("maps the headline status codes to the documented http_status", () => {
		expect(GRPC_STATUS_MAP[GrpcStatus.INVALID_ARGUMENT].httpStatus).toBe(400);
		expect(GRPC_STATUS_MAP[GrpcStatus.DEADLINE_EXCEEDED].httpStatus).toBe(504);
		expect(GRPC_STATUS_MAP[GrpcStatus.NOT_FOUND].httpStatus).toBe(404);
		expect(GRPC_STATUS_MAP[GrpcStatus.PERMISSION_DENIED].httpStatus).toBe(403);
		expect(GRPC_STATUS_MAP[GrpcStatus.RESOURCE_EXHAUSTED].httpStatus).toBe(429);
		expect(GRPC_STATUS_MAP[GrpcStatus.UNIMPLEMENTED].httpStatus).toBe(501);
		expect(GRPC_STATUS_MAP[GrpcStatus.INTERNAL].httpStatus).toBe(500);
		expect(GRPC_STATUS_MAP[GrpcStatus.UNAVAILABLE].httpStatus).toBe(503);
		expect(GRPC_STATUS_MAP[GrpcStatus.UNAUTHENTICATED].httpStatus).toBe(401);
	});

	it("maps the headline status codes to the documented category", () => {
		expect(GRPC_STATUS_MAP[GrpcStatus.INVALID_ARGUMENT].category).toBe(ErrorCategory.VALIDATION);
		expect(GRPC_STATUS_MAP[GrpcStatus.DEADLINE_EXCEEDED].category).toBe(ErrorCategory.TIMEOUT);
		expect(GRPC_STATUS_MAP[GrpcStatus.PERMISSION_DENIED].category).toBe(ErrorCategory.PERMISSION);
		expect(GRPC_STATUS_MAP[GrpcStatus.RESOURCE_EXHAUSTED].category).toBe(ErrorCategory.RATE_LIMIT);
		expect(GRPC_STATUS_MAP[GrpcStatus.UNAVAILABLE].category).toBe(ErrorCategory.DEPENDENCY);
		expect(GRPC_STATUS_MAP[GrpcStatus.UNIMPLEMENTED].category).toBe(ErrorCategory.PROTOCOL);
		expect(GRPC_STATUS_MAP[GrpcStatus.UNAUTHENTICATED].category).toBe(ErrorCategory.PERMISSION);
	});
});

describe("isServiceError", () => {
	it("recognizes a duck-typed gRPC ServiceError", () => {
		expect(isServiceError(makeServiceError(GrpcStatus.UNAVAILABLE))).toBe(true);
	});

	it("rejects plain Errors", () => {
		expect(isServiceError(new Error("plain"))).toBe(false);
	});

	it("rejects null/undefined/primitives", () => {
		expect(isServiceError(null)).toBe(false);
		expect(isServiceError(undefined)).toBe(false);
		expect(isServiceError(42)).toBe(false);
		expect(isServiceError("error")).toBe(false);
	});
});

describe("toBlokError", () => {
	it("passes through an existing BlokError unchanged", () => {
		const original = BlokError.dependency({ code: "DB_DOWN", message: "x" });
		expect(toBlokError(original, ctx)).toBe(original);
	});

	it("converts a ServiceError to a BlokError using the status map", () => {
		const err = makeServiceError(GrpcStatus.INVALID_ARGUMENT, "bad input");
		const blok = toBlokError(err, ctx);
		expect(blok.category).toBe(ErrorCategory.VALIDATION);
		expect(blok.httpStatus).toBe(400);
		expect(blok.errorCode).toBe("GRPC_INVALID_ARGUMENT");
		expect(blok.message).toBe("bad input");
		expect(blok.nodeName).toBe(ctx.node);
		expect(blok.sdk).toBe(ctx.sdk);
		expect(blok.runtimeKind).toBe(ctx.runtimeKind);
	});

	it("rehydrates a structured payload from blok-error-bin metadata", () => {
		const original = BlokError.dependency({
			code: "POSTGRES_CONNECT_TIMEOUT",
			message: "Could not connect within 5s",
			description: "host=db port=5432 timeout=5000ms",
			remediation: "Check DATABASE_URL",
			node: "store-tutorial",
			sdk: "blok-python3",
			retryable: true,
			retryAfterMs: 2000,
			details: { sqlState: "08001" },
		});
		const md = new Metadata();
		md.set("blok-error-bin", Buffer.from(JSON.stringify(original.toJSON()), "utf-8"));

		const err = makeServiceError(GrpcStatus.UNAVAILABLE, "stream closed", md);
		const blok = toBlokError(err, ctx);

		// Payload-driven values should win over status-driven defaults.
		expect(blok.errorCode).toBe("POSTGRES_CONNECT_TIMEOUT");
		expect(blok.category).toBe(ErrorCategory.DEPENDENCY);
		expect(blok.message).toBe("Could not connect within 5s");
		expect(blok.description).toContain("port=5432");
		expect(blok.remediation).toContain("DATABASE_URL");
		expect(blok.retryable).toBe(true);
		expect(blok.retryAfterMs).toBe(2000);
		expect(blok.details).toEqual({ sqlState: "08001" });
	});

	it("falls back to status-based mapping when metadata is malformed JSON", () => {
		const md = new Metadata();
		md.set("blok-error-bin", Buffer.from("not json"));

		const err = makeServiceError(GrpcStatus.UNAVAILABLE, "stream closed", md);
		const blok = toBlokError(err, ctx);

		expect(blok.category).toBe(ErrorCategory.DEPENDENCY);
		expect(blok.errorCode).toBe("GRPC_UNAVAILABLE");
	});

	it("falls back to status-based mapping when metadata payload is incomplete", () => {
		const md = new Metadata();
		md.set("blok-error-bin", Buffer.from(JSON.stringify({ irrelevant: true })));

		const err = makeServiceError(GrpcStatus.INTERNAL, "boom", md);
		const blok = toBlokError(err, ctx);

		expect(blok.category).toBe(ErrorCategory.INTERNAL);
		expect(blok.errorCode).toBe("GRPC_INTERNAL");
	});

	it("wraps a plain Error via fromUnknown", () => {
		const blok = toBlokError(new TypeError("bad type"), ctx);
		expect(blok.category).toBe(ErrorCategory.INTERNAL);
		expect(blok.errorCode).toBe("UNCAUGHT_TYPEERROR");
		expect(blok.nodeName).toBe(ctx.node);
	});

	it("wraps a non-Error thrown value", () => {
		const blok = toBlokError("oops", ctx);
		expect(blok.category).toBe(ErrorCategory.INTERNAL);
		expect(blok.errorCode).toBe("UNCAUGHT_ERROR");
		expect(blok.message).toBe("oops");
	});

	it("captures details about the underlying gRPC status when fallback is taken", () => {
		const err = makeServiceError(GrpcStatus.RESOURCE_EXHAUSTED, "rate limited");
		const blok = toBlokError(err, ctx);
		expect(blok.details).toEqual({
			grpcStatus: "RESOURCE_EXHAUSTED",
			grpcMessage: expect.any(String),
		});
	});
});

describe("categoryToGrpcStatus", () => {
	it("inverts the status map for the headline categories", () => {
		expect(categoryToGrpcStatus(ErrorCategory.VALIDATION)).toBe(GrpcStatus.INVALID_ARGUMENT);
		expect(categoryToGrpcStatus(ErrorCategory.TIMEOUT)).toBe(GrpcStatus.DEADLINE_EXCEEDED);
		expect(categoryToGrpcStatus(ErrorCategory.PERMISSION)).toBe(GrpcStatus.PERMISSION_DENIED);
		expect(categoryToGrpcStatus(ErrorCategory.RATE_LIMIT)).toBe(GrpcStatus.RESOURCE_EXHAUSTED);
		expect(categoryToGrpcStatus(ErrorCategory.DEPENDENCY)).toBe(GrpcStatus.UNAVAILABLE);
	});

	it("falls back to INTERNAL for an unrecognized category value", () => {
		expect(categoryToGrpcStatus("MADE_UP" as unknown as ErrorCategory)).toBe(GrpcStatus.INTERNAL);
	});
});
