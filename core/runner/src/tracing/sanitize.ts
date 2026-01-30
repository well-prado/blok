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
]);

const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024; // 10KB
const REDACTED = "[REDACTED]";
const TRUNCATED_SUFFIX = "...[TRUNCATED]";

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

function redactFields(obj: unknown, sensitiveFields: Set<string>, depth = 0): unknown {
	if (depth > 20) return "[MAX_DEPTH]";

	if (obj === null || obj === undefined) return obj;

	if (typeof obj === "string") return obj;
	if (typeof obj === "number" || typeof obj === "boolean") return obj;

	if (Array.isArray(obj)) {
		return obj.map((item) => redactFields(item, sensitiveFields, depth + 1));
	}

	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (sensitiveFields.has(key.toLowerCase())) {
				result[key] = REDACTED;
			} else {
				result[key] = redactFields(value, sensitiveFields, depth + 1);
			}
		}
		return result;
	}

	return String(obj);
}

/**
 * Sanitize a payload for trace storage:
 * 1. Redact sensitive fields (passwords, tokens, etc.)
 * 2. Truncate if the serialized payload exceeds the max size
 * 3. Handle circular references and non-serializable values
 */
export function sanitize(payload: unknown): unknown {
	if (payload === null || payload === undefined) return payload;

	try {
		const sensitiveFields = getSensitiveFields();
		const redacted = redactFields(payload, sensitiveFields);

		const maxBytes = getMaxPayloadBytes();
		const serialized = JSON.stringify(redacted);

		if (serialized.length > maxBytes) {
			return {
				_truncated: true,
				_originalSize: serialized.length,
				_maxSize: maxBytes,
				_preview: serialized.slice(0, Math.min(500, maxBytes)) + TRUNCATED_SUFFIX,
			};
		}

		return redacted;
	} catch {
		return { _error: "Failed to sanitize payload" };
	}
}
