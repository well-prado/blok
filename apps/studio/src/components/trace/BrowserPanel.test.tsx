import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

	it("replays a selected artifact and returns to the live frame", async () => {
		const onShowLive = vi.fn();
		const user = userEvent.setup();
		render(
			<BrowserPanel
				session={{
					sessionId: "session-1",
					pageId: "page-1",
					stream: "/stream",
					status: "closed",
					autoOpen: true,
				}}
				events={[]}
				selectedArtifact={{
					id: "artifact-1",
					runId: "run-1",
					kind: "screenshot",
					name: "click-after",
					mimeType: "image/png",
					size: 100,
					createdAt: 1,
					url: "/artifact.png",
				}}
				onShowLive={onShowLive}
			/>,
		);

		expect(screen.getByAltText("Browser artifact: click-after")).toHaveAttribute("src", "/artifact.png");
		await user.click(screen.getByRole("button", { name: /show live/i }));
		expect(onShowLive).toHaveBeenCalledOnce();
	});
});
