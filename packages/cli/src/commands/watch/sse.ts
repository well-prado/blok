import type { WatchRunEvent } from "./format.js";

export interface ConnectOptions {
	token?: string;
	workflows?: string[];
	signal?: AbortSignal;
}

export interface StreamHandlers {
	onOpen?: () => void;
	onEvent: (event: WatchRunEvent) => void;
	onError?: (error: Error) => void;
}

/**
 * Parse one SSE frame (the text between blank-line separators) into a
 * `WatchRunEvent`, or `null` for control/comment frames (`:heartbeat`,
 * `connected`, `stream-end`) and anything whose `data:` isn't a run event.
 */
function parseFrame(frame: string): WatchRunEvent | null {
	let eventType: string | null = null;
	const dataLines: string[] = [];
	for (const raw of frame.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (line.length === 0 || line.startsWith(":")) continue; // comment / heartbeat
		if (line.startsWith("event:")) eventType = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (dataLines.length === 0) return null;
	if (eventType === "connected" || eventType === "stream-end") return null;
	try {
		const parsed = JSON.parse(dataLines.join("\n")) as unknown;
		if (parsed && typeof parsed === "object" && "runId" in parsed && "type" in parsed) {
			return parsed as WatchRunEvent;
		}
	} catch {
		// Tolerate a malformed/partial frame — skip it rather than crash the watch.
	}
	return null;
}

/**
 * Pull complete SSE frames out of an accumulating buffer. Returns the parsed
 * events and the unconsumed remainder (a possibly-partial trailing frame).
 * Pure + deterministic, so it is unit-tested directly.
 */
export function parseSseBuffer(buffer: string): { events: WatchRunEvent[]; rest: string } {
	const events: WatchRunEvent[] = [];
	// Normalize CRLF → LF so frame detection works regardless of the server's
	// line endings. Idempotent across chunks: the carried `rest` is re-normalized
	// on the next call once a split `\r\n` completes.
	let rest = buffer.replace(/\r\n/g, "\n");
	let sep = rest.indexOf("\n\n");
	while (sep !== -1) {
		const frame = rest.slice(0, sep);
		rest = rest.slice(sep + 2);
		const event = parseFrame(frame);
		if (event) events.push(event);
		sep = rest.indexOf("\n\n");
	}
	return { events, rest };
}

/**
 * Connect to a deployment's global event stream (`GET /__blok/stream`) and
 * invoke `handlers` as run/node events arrive. Resolves when the stream ends
 * or the `signal` aborts. Uses streaming `fetch` — no EventSource polyfill.
 */
export async function connectEventStream(
	baseUrl: string,
	opts: ConnectOptions,
	handlers: StreamHandlers,
): Promise<void> {
	const url = new URL("/__blok/stream", baseUrl);
	if (opts.workflows && opts.workflows.length > 0) {
		url.searchParams.set("workflows", opts.workflows.join(","));
	}
	const headers: Record<string, string> = { accept: "text/event-stream" };
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;

	let res: Response;
	try {
		res = await fetch(url, { headers, signal: opts.signal });
	} catch (err) {
		if ((err as Error)?.name !== "AbortError") handlers.onError?.(err as Error);
		return;
	}

	if (!res.ok || !res.body) {
		handlers.onError?.(new Error(`stream connect failed: ${res.status} ${res.statusText || ""}`.trim()));
		return;
	}

	handlers.onOpen?.();
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { events, rest } = parseSseBuffer(buffer);
			buffer = rest;
			for (const event of events) handlers.onEvent(event);
		}
	} catch (err) {
		if ((err as Error)?.name !== "AbortError") handlers.onError?.(err as Error);
	}
}
