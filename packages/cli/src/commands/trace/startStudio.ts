import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import open from "open";
import color from "picocolors";
// @ts-ignore
import serveHandler from "serve-handler";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StudioOptions {
	port: number;
	url: string;
	workflow?: string;
	run?: string;
	open: boolean;
}

/**
 * Resolve the path to the built Studio SPA assets.
 * Tries bundled location first (distributed CLI), then workspace location (dev).
 */
function resolveStaticPath(): string | null {
	// Bundled location: packages/cli/dist/studio-dist/
	const bundled = path.resolve(__dirname, "../../studio-dist");
	if (fs.existsSync(path.join(bundled, "index.html"))) return bundled;

	// Workspace dev location: apps/studio/dist/
	const workspace = path.resolve(__dirname, "../../../../apps/studio/dist");
	if (fs.existsSync(path.join(workspace, "index.html"))) return workspace;

	return null;
}

/**
 * Ping the Blok backend's health endpoint to verify it's running.
 */
async function checkBackendHealth(backendUrl: string): Promise<boolean> {
	return new Promise((resolve) => {
		const url = new URL("/__blok/health", backendUrl);
		const client = url.protocol === "https:" ? https : http;
		const req = client.get(url, { timeout: 3000 }, (res) => {
			resolve(res.statusCode === 200);
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
	});
}

/**
 * Reverse-proxy a request to the Blok backend.
 * Handles REST + SSE streams transparently via pipe.
 */
function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, backendUrl: string) {
	const targetUrl = new URL(req.url!, backendUrl);
	const client = targetUrl.protocol === "https:" ? https : http;

	const proxyReq = client.request(
		targetUrl,
		{
			method: req.method,
			headers: {
				...req.headers,
				host: targetUrl.host,
			},
		},
		(proxyRes) => {
			res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
			proxyRes.pipe(res, { end: true });
		},
	);

	proxyReq.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Backend unavailable" }));
		}
	});

	// Abort proxy when client disconnects (important for SSE streams)
	req.on("close", () => {
		proxyReq.destroy();
	});

	req.pipe(proxyReq, { end: true });
}

/**
 * Start the Blok Studio server:
 * 1. Verify backend is reachable
 * 2. Serve built Studio SPA, proxying /__blok/* to the backend
 * 3. Open browser
 */
export async function startStudio(options: StudioOptions): Promise<void> {
	const { port, url: backendUrl, open: shouldOpen } = options;

	p.intro(color.bgCyan(color.black(" Blok Studio ")));

	// Resolve Studio static assets
	const staticPath = resolveStaticPath();
	if (!staticPath) {
		p.log.error(`Studio assets not found.\n` + `  Build them first: ${color.cyan("pnpm --filter @blokjs/studio build")}`);
		process.exit(1);
	}

	// Health check
	const s = p.spinner();
	s.start("Checking backend health...");

	const healthy = await checkBackendHealth(backendUrl);
	if (!healthy) {
		s.stop(color.yellow("Backend not reachable"));
		p.log.warn(
			`Blok backend not found at ${color.cyan(backendUrl)}\n` + `  Start it first: ${color.cyan("blokctl dev")}`,
		);
		p.log.info("Starting Studio anyway — it will connect when the backend is up.");
	} else {
		s.stop(color.green("Backend healthy"));
	}

	// Create HTTP server
	const server = http.createServer((req, res) => {
		const url = req.url || "/";

		// Proxy /__blok/* requests to the Blok backend
		if (url.startsWith("/__blok")) {
			return proxyRequest(req, res, backendUrl);
		}

		// Serve static SPA files with fallback to index.html
		serveHandler(req, res, {
			public: staticPath,
			rewrites: [{ source: "**", destination: "/index.html" }],
		});
	});

	return new Promise<void>(() => {
		server.listen(port, async () => {
			let studioUrl = `http://localhost:${port}`;

			if (options.workflow) {
				studioUrl += `/workflows/${encodeURIComponent(options.workflow)}`;
			} else if (options.run) {
				studioUrl += `/runs/${encodeURIComponent(options.run)}`;
			}

			p.log.success(`Studio running at ${color.cyan(studioUrl)}`);
			p.log.info(`Connected to backend at ${color.dim(backendUrl)}`);
			console.log(color.dim("  Press Ctrl+C to stop\n"));

			if (shouldOpen) {
				await open(studioUrl);
			}
		});

		// Graceful shutdown
		const stop = () => {
			console.log();
			server.close(() => {
				p.outro(color.dim("Blok Studio stopped."));
				process.exit(0);
			});
			// Force exit after 3s if server doesn't close cleanly
			setTimeout(() => process.exit(0), 3000);
		};

		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		process.once("SIGQUIT", stop);
	});
}
