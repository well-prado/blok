import type { JsonLikeObject } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";

/**
 * Parse a `Retry-After` header into seconds. The header is either a number of
 * seconds (delta) or an HTTP-date; returns `undefined` when absent/unparseable.
 */
function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const asNumber = Number(value);
	if (Number.isFinite(asNumber)) return Math.max(0, asNumber);
	const asDate = Date.parse(value);
	if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
	return undefined;
}

export const runApiCall = async (
	url: string,
	method: string,
	headers: JsonLikeObject,
	body: JsonLikeObject,
	responseType: string,
): Promise<string | JsonLikeObject> => {
	const options: {
		method: string;
		headers: JsonLikeObject;
		redirect: "follow";
		responseType: string;
		body: string | undefined;
	} = {
		method,
		headers,
		redirect: "follow",
		responseType,
		body: typeof body === "string" ? body : JSON.stringify(body),
	};

	if (method === "GET") options.body = undefined;
	const response: Response = await fetch(url, options as RequestInit);

	if (response.status >= 400 && response.ok === false) {
		// Don't discard the upstream signal. Capture the body and the rate-limit
		// headers, and throw a GlobalError carrying the *upstream* status code so a
		// 429/503 surfaces as a retryable 429/503 (not a generic 500) and callers
		// (or a `tryCatch` arm) can honor `Retry-After` instead of hammering the
		// provider. The framework preserves a thrown GlobalError's code verbatim.
		const contentType = response.headers.get("content-type") ?? "";
		let responseBody: string | JsonLikeObject | undefined;
		try {
			responseBody = contentType.includes("application/json")
				? ((await response.json()) as JsonLikeObject)
				: await response.text();
		} catch {
			responseBody = undefined;
		}

		const retryAfterRaw = response.headers.get("retry-after");
		const retryAfterSeconds = parseRetryAfterSeconds(retryAfterRaw);

		const error = new GlobalError(`API call to ${url} failed: ${response.status} ${response.statusText || ""}`.trim());
		error.setName("ApiCallError");
		error.setCode(response.status);
		error.setJson({
			status: response.status,
			statusText: response.statusText,
			url,
			...(retryAfterRaw !== null ? { retryAfter: retryAfterRaw, retryAfterSeconds } : {}),
			...(responseBody !== undefined ? { body: responseBody } : {}),
		});
		throw error;
	}

	let parsedResponse: string | JsonLikeObject;
	if (response.headers.get("content-type")?.includes("application/json")) {
		parsedResponse = await response.json();
	} else {
		parsedResponse = await response.text();
	}

	return parsedResponse;
};
