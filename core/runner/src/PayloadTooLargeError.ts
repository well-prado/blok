/**
 * PR 2 follow-up · A4 fix.
 *
 * Thrown by `HttpTrigger.extractDispatchPayload` when a request body
 * would push the durable scheduler row past `BLOK_DISPATCH_PAYLOAD_MAX_BYTES`
 * (default 1MB). Distinct error class so the HTTP transport can translate
 * to `413 Payload Too Large` with structured info instead of a generic 500.
 *
 * Operators tune the cap via `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` (number,
 * bytes). Authors with large-payload workflows (file uploads, etc.) can
 * either raise the cap, pre-strip the body before deferring, or skip
 * durable persistence entirely (don't override `extractDispatchPayload`).
 */
export class PayloadTooLargeError extends Error {
	readonly actualBytes: number;
	readonly maxBytes: number;

	constructor(actualBytes: number, maxBytes: number, message?: string) {
		super(
			message ??
				`Dispatch payload too large for durable scheduling: ${actualBytes} bytes exceeds cap of ${maxBytes} bytes (configurable via BLOK_DISPATCH_PAYLOAD_MAX_BYTES).`,
		);
		this.name = "PayloadTooLargeError";
		this.actualBytes = actualBytes;
		this.maxBytes = maxBytes;
		Object.setPrototypeOf(this, PayloadTooLargeError.prototype);
	}
}

export function isPayloadTooLargeError(err: unknown): err is PayloadTooLargeError {
	return err instanceof PayloadTooLargeError;
}
