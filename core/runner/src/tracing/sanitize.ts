const DEFAULT_SENSITIVE_FIELDS = new Set([
	"password",
	"secret",
	"token",
	"key",
	"api_key",
	"apikey",
	"api-key",
	"authorization",
	"auth",
	"credential",
	"credentials",
	"private_key",
	"privatekey",
	"access_token",
	"refresh_token",
	"client_secret",
	"session",
	"cookie",
	"bearer",
	"bearer_token",
	"jwt",
	"csrf",
	"csrftoken",
	"csrf_token",
	"oauth",
	"oauth_token",
]);

const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024; // 10KB
const REDACTED = "[REDACTED]";
const TRUNCATED_SUFFIX = "...[TRUNCATED]";
const ELIDED = "[…]";
/** Nodes the preview walk may copy — comfortably more than 500 chars' worth. */
const PREVIEW_NODE_BUDGET = 200;

function getSensitiveFields(): Set<string> {
	const envFields = process.env.BLOK_TRACE_SANITIZE_FIELDS;
	if (envFields) {
		const extra = envFields.split(",").map((f) => f.trim().toLowerCase());
		return new Set([...DEFAULT_SENSITIVE_FIELDS, ...extra]);
	}
	return DEFAULT_SENSITIVE_FIELDS;
}

function getMaxPayloadBytes(): number {
	const envMax = process.env.BLOK_TRACE_PAYLOAD_MAX_KB;
	if (envMax) {
		const kb = Number.parseInt(envMax, 10);
		if (!Number.isNaN(kb) && kb > 0) return kb * 1024;
	}
	return DEFAULT_MAX_PAYLOAD_BYTES;
}

/**
 * `budget` bounds how many nodes the walk may copy. Only the oversized-payload
 * preview passes one: that result is sliced to 500 chars anyway, so copying the
 * whole payload to build it is pure waste. Unbudgeted callers are unchanged.
 */
function redactFields(obj: unknown, sensitiveFields: Set<string>, depth = 0, budget?: { left: number }): unknown {
	if (depth > 20) return "[MAX_DEPTH]";
	if (budget && budget.left-- <= 0) return ELIDED;

	if (obj === null || obj === undefined) return obj;

	if (typeof obj === "string") return obj;
	if (typeof obj === "number" || typeof obj === "boolean") return obj;

	if (Array.isArray(obj)) {
		return obj.map((item) => redactFields(item, sensitiveFields, depth + 1, budget));
	}

	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (sensitiveFields.has(key.toLowerCase())) {
				result[key] = REDACTED;
			} else {
				result[key] = redactFields(value, sensitiveFields, depth + 1, budget);
			}
		}
		return result;
	}

	return String(obj);
}

/** The oversized-payload stub. `preview` is always built from REDACTED data. */
function truncationStub(preview: string, originalSize: number, maxBytes: number): Record<string, unknown> {
	return {
		_truncated: true,
		_originalSize: originalSize,
		_maxSize: maxBytes,
		_preview: preview.slice(0, Math.min(500, maxBytes)) + TRUNCATED_SUFFIX,
	};
}

/**
 * Redact sensitive fields from a payload WITHOUT applying the
 * trace-storage size cap. Use this when the caller has its own
 * size budget (e.g. `extractDispatchPayload` enforces a 1MB cap
 * via `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` and would double-truncate
 * if it called `sanitize()` directly).
 *
 * Same field list + extension semantics as `sanitize()`. Honors
 * `BLOK_TRACE_SANITIZE_FIELDS` for runtime additions.
 */
export function redactSensitive(payload: unknown): unknown {
	if (payload === null || payload === undefined) return payload;
	try {
		const sensitiveFields = getSensitiveFields();
		return redactFields(payload, sensitiveFields);
	} catch {
		return { _error: "Failed to redact payload" };
	}
}

/**
 * Sanitize a payload for trace storage:
 * 1. Size-check the payload
 * 2. Redact sensitive fields (passwords, tokens, etc.) — never more than is kept
 * 3. Handle circular references and non-serializable values
 *
 * Order matters. Redacting first means structurally copying the WHOLE payload
 * before discovering it's oversized and keeping a 500-char preview of it —
 * millions of allocations thrown away, which pegged the event loop for minutes
 * on a large step aggregate (39k symbols) and made the server look frozen.
 * The size check now runs on the raw payload, and an oversized one is only
 * walked as far as its preview needs.
 */
export function sanitize(payload: unknown): unknown {
	if (payload === null || payload === undefined) return payload;

	try {
		const sensitiveFields = getSensitiveFields();
		const maxBytes = getMaxPayloadBytes();

		// One serialization pass, no copy. Circular / non-serializable payloads
		// throw or yield undefined here; they fall through to the copy path below,
		// whose depth cap breaks cycles exactly as it always did.
		let rawSize: number | undefined;
		try {
			rawSize = JSON.stringify(payload)?.length;
		} catch {
			rawSize = undefined;
		}

		if (rawSize !== undefined && rawSize > maxBytes) {
			const preview = JSON.stringify(redactFields(payload, sensitiveFields, 0, { left: PREVIEW_NODE_BUDGET }));
			return truncationStub(preview ?? "", rawSize, maxBytes);
		}

		const redacted = redactFields(payload, sensitiveFields);
		const serialized = JSON.stringify(redacted);
		// Catches what the raw check couldn't: payloads that aren't serializable
		// until redaction stringifies their exotic values, plus the edge where
		// replacing a short secret with "[REDACTED]" tips a borderline payload over.
		if (serialized !== undefined && serialized.length > maxBytes) {
			return truncationStub(serialized, serialized.length, maxBytes);
		}

		return redacted;
	} catch {
		return { _error: "Failed to sanitize payload" };
	}
}
