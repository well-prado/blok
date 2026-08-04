import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRunStream } from "./sse";

class MockEventSource {
	static instance: MockEventSource;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	listeners = new Map<string, EventListener>();
	close = vi.fn();

	constructor(readonly url: string) {
		MockEventSource.instance = this;
	}

	addEventListener(type: string, listener: EventListener) {
		this.listeners.set(type, listener);
	}
}

describe("run SSE", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("subscribes to browser semantic events", () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const disconnect = connectRunStream("run-1", { onEvent: vi.fn() });

		expect([...MockEventSource.instance.listeners.keys()]).toEqual(
			expect.arrayContaining([
				"BROWSER_SESSION_OPENED",
				"BROWSER_PAGE_UPDATED",
				"BROWSER_ACTION",
				"BROWSER_ARTIFACT",
				"BROWSER_SESSION_CLOSED",
			]),
		);
		disconnect();
	});
});
