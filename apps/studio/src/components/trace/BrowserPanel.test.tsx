import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "./BrowserPanel";

class MockWebSocket {
	static instance: MockWebSocket;
	binaryType = "";
	onopen?: () => void;
	onmessage?: (event: MessageEvent) => void;
	onerror?: () => void;
	onclose?: () => void;
	send = vi.fn();
	close = vi.fn();

	constructor(readonly url: string) {
		MockWebSocket.instance = this;
	}
}

describe("BrowserPanel", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
	});

	afterEach(() => vi.restoreAllMocks());

	it("renders semantic actions and acknowledges streamed frames", () => {
		render(
			<BrowserPanel
				session={{
					sessionId: "session-1",
					pageId: "page-1",
					stream: "/__blok/browser/sessions/session-1/stream?runId=run-1",
					url: "https://example.com/login",
					status: "live",
					autoOpen: true,
				}}
				events={[
					{
						id: "event-1",
						type: "BROWSER_ACTION",
						runId: "run-1",
						workflowName: "login",
						timestamp: 1,
						payload: { action: "click", phase: "completed", locator: { role: "button", name: "Submit" } },
					},
				]}
			/>,
		);

		expect(String(MockWebSocket.instance.url)).toBe(
			"ws://localhost:3000/__blok/browser/sessions/session-1/stream?runId=run-1",
		);
		expect(screen.getByText("role=button · name=Submit")).toBeInTheDocument();

		act(() => {
			MockWebSocket.instance.onopen?.();
			MockWebSocket.instance.onmessage?.({
				data: JSON.stringify({ type: "frame", frameId: 7, width: 1280, height: 720 }),
			} as MessageEvent);
			MockWebSocket.instance.onmessage?.({ data: new Blob(["jpeg"]) } as MessageEvent);
		});

		expect(screen.getByAltText("Live browser frame")).toHaveAttribute("src", "blob:frame");
		expect(MockWebSocket.instance.send).toHaveBeenCalledWith(JSON.stringify({ type: "ack", frameId: 7 }));
	});
});
