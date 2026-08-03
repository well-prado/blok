import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, type CDPSession, chromium } from "playwright";
import { WebSocket, WebSocketServer } from "ws";

const spikeDir = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.resolve(spikeDir, "../../_design/_screenshots");
const maxFramesPerSecond = 10;
const maxBufferedBytes = 1_000_000;

interface ScreencastFrame {
	data: string;
	sessionId: number;
}

interface ClientState {
	awaitingAck: boolean;
	lastFrameId: number;
}

interface SpikeStats {
	receivedFrames: number;
	sentFrames: number;
	ackedFrames: number;
	droppedFrames: number;
	actions: string[];
}

const stats: SpikeStats = {
	receivedFrames: 0,
	sentFrames: 0,
	ackedFrames: 0,
	droppedFrames: 0,
	actions: [],
};

let nextFrameId = 0;
let latestFrame: { id: number; jpeg: Buffer } | undefined;
let cdp: CDPSession | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

const [viewerHtml, fixtureHtml, dashboardHtml] = await Promise.all([
	readFile(path.join(spikeDir, "viewer.html"), "utf8"),
	readFile(path.join(spikeDir, "fixture.html"), "utf8"),
	readFile(path.join(spikeDir, "dashboard.html"), "utf8"),
]);

const httpServer = createServer((req, res) => {
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (pathname === "/") return sendHtml(res, viewerHtml);
	if (pathname === "/fixture") return sendHtml(res, fixtureHtml);
	if (pathname === "/fixture/dashboard") return sendHtml(res, dashboardHtml);
	if (pathname === "/stats") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(stats));
		return;
	}
	res.writeHead(404).end("Not found");
});

const sockets = new WebSocketServer({ noServer: true });
const clientState = new WeakMap<WebSocket, ClientState>();

httpServer.on("upgrade", (request, socket, head) => {
	if (new URL(request.url ?? "/", "http://localhost").pathname !== "/stream") {
		socket.destroy();
		return;
	}
	sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
});

sockets.on("connection", (socket) => {
	clientState.set(socket, { awaitingAck: false, lastFrameId: 0 });
	socket.send(JSON.stringify({ type: "stats", stats }));
	socket.on("message", (raw) => {
		const message = JSON.parse(raw.toString()) as { type?: string; frameId?: number };
		const state = clientState.get(socket);
		if (message.type !== "ack" || !state || message.frameId !== state.lastFrameId) return;
		state.awaitingAck = false;
		stats.ackedFrames++;
	});
});

const frameTimer = setInterval(() => {
	if (!latestFrame) return;
	let delivered = false;
	for (const socket of sockets.clients) {
		const state = clientState.get(socket);
		if (
			socket.readyState !== WebSocket.OPEN ||
			!state ||
			state.awaitingAck ||
			socket.bufferedAmount > maxBufferedBytes
		) {
			continue;
		}
		state.awaitingAck = true;
		state.lastFrameId = latestFrame.id;
		socket.send(JSON.stringify({ type: "frame", frameId: latestFrame.id, mimeType: "image/jpeg" }));
		socket.send(latestFrame.jpeg, { binary: true });
		stats.sentFrames++;
		delivered = true;
	}
	if (delivered) latestFrame = undefined;
}, 1000 / maxFramesPerSecond);

async function main(): Promise<void> {
	await mkdir(screenshotsDir, { recursive: true });
	await listen();
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("Spike server did not bind a TCP port.");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	browser = await chromium.launch({ headless: true });
	context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const target = await context.newPage();
	const viewer = await context.newPage();
	cdp = await context.newCDPSession(target);
	cdp.on("Page.screencastFrame", (event: ScreencastFrame) => {
		void cdp?.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
		stats.receivedFrames++;
		if (latestFrame) stats.droppedFrames++;
		latestFrame = { id: ++nextFrameId, jpeg: Buffer.from(event.data, "base64") };
	});
	await cdp.send("Page.startScreencast", {
		format: "jpeg",
		quality: 72,
		maxWidth: 1280,
		maxHeight: 720,
		everyNthFrame: 1,
	});

	await viewer.goto(`${baseUrl}/?ackDelay=250`);
	await viewer.locator("[data-connected='true']").waitFor();

	await action("goto", async () => {
		await target.goto(`${baseUrl}/fixture`);
	});
	await action("fill", async () => {
		await target.getByLabel("Email").fill("alice@example.com");
		await target.getByLabel("Password").fill("correct-horse-battery-staple");
	});
	await action("click", async () => {
		await Promise.all([
			target.waitForURL((url) => url.pathname === "/fixture/dashboard"),
			target.getByRole("button", { name: "Sign in" }).click(),
		]);
	});

	await viewer.locator("[data-action-count='3']").waitFor();
	await viewer.waitForFunction(
		() => Number(document.querySelector("[data-frame-count]")?.getAttribute("data-frame-count")) >= 3,
	);
	await target.screenshot({ path: path.join(screenshotsDir, "cdp-target-dashboard.png") });
	await viewer.screenshot({ path: path.join(screenshotsDir, "cdp-screencast-panel.png"), fullPage: true });

	if (stats.actions.length !== 3 || stats.ackedFrames < 1 || stats.droppedFrames < 1) {
		throw new Error(
			`CDP spike did not exercise actions, acknowledgements, and frame dropping: ${JSON.stringify(stats)}`,
		);
	}

	console.log(`BLOK CDP spike passed at ${baseUrl}`);
	console.log(JSON.stringify(stats, null, 2));
	console.log(`Panel proof: ${path.join(screenshotsDir, "cdp-screencast-panel.png")}`);

	if (process.argv.includes("--keep-open")) {
		console.log("Open the URL above; press Ctrl+C to stop.");
		await new Promise<void>((resolve) => process.once("SIGINT", resolve));
	}
}

async function action(name: string, run: () => Promise<void>): Promise<void> {
	broadcast({ type: "action", name, phase: "running" });
	await run();
	stats.actions.push(name);
	broadcast({ type: "action", name, phase: "completed" });
	await new Promise((resolve) => setTimeout(resolve, 300));
}

function broadcast(message: unknown): void {
	const encoded = JSON.stringify(message);
	for (const socket of sockets.clients) {
		if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
	}
}

function listen(): Promise<void> {
	return new Promise((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", resolve);
	});
}

function sendHtml(res: import("node:http").ServerResponse, body: string): void {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

async function cleanup(): Promise<void> {
	clearInterval(frameTimer);
	console.log("Stopping CDP screencast…");
	await cdp?.send("Page.stopScreencast").catch(() => undefined);
	await cdp?.detach().catch(() => undefined);
	cdp = undefined;
	console.log("Closing browser context…");
	await context?.close().catch(() => undefined);
	await browser?.close().catch(() => undefined);
	console.log("Closing WebSocket server…");
	const socketsClosed = new Promise<void>((resolve) => sockets.close(() => resolve()));
	for (const socket of sockets.clients) socket.terminate();
	await socketsClosed;
	console.log("Closing HTTP server…");
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	console.log("CDP spike cleanup complete.");
}

try {
	await main();
} finally {
	await cleanup();
}
