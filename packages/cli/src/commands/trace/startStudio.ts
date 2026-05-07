import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import express from "express";
import open from "open";
import color from "picocolors";
// @ts-ignore
import serveHandler from "serve-handler";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StudioOptions {
	port: number;
	url: string;
	/** Path to a SQLite trace file. When set, runs in standalone mode (no trigger needed). */
	db?: string;
	/** Force standalone mode even if no `--db` is passed; auto-resolves .blok/trace.db */
	standalone?: boolean;
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
 * Auto-detect a project-local SQLite trace file. Looks at the standard
 * `.blok/trace.db` path relative to the user's cwd. Used when the
 * operator runs `blokctl studio` from inside a project without flags
 * — the Prisma-Studio "open the project, see your data" UX.
 */
function autoDetectDbPath(): string | null {
	const candidate = path.resolve(process.cwd(), ".blok", "trace.db");
	return fs.existsSync(candidate) ? candidate : null;
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
	const targetUrl = new URL(req.url ?? "/", backendUrl);
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
 * Standalone mode — mount /__blok/* directly on an Express app reading
 * from a SQLite file. The Prisma-Studio UX: operator runs
 * `blokctl studio` against an existing trace file, no trigger needed.
 *
 * Imports `@blokjs/runner` lazily so the cold path of proxy mode
 * doesn't pay the import cost. better-sqlite3 is a direct CLI dep so
 * the SqliteRunStore works out of the box even when the user isn't
 * inside a workspace that has it installed.
 */
async function buildStandaloneApp(dbPath: string): Promise<express.Application> {
	const runner = (await import("@blokjs/runner")) as typeof import("@blokjs/runner");
	const { RunTracker, createStore, registerTraceRoutes } = runner;

	const absoluteDb = path.resolve(dbPath);
	const dir = path.dirname(absoluteDb);
	if (dir && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const store = createStore({ type: "sqlite", sqlitePath: absoluteDb });
	const tracker = new RunTracker(undefined, store);
	// Make this tracker the singleton so the registered routes see it.
	(RunTracker as unknown as { instance: typeof tracker }).instance = tracker;

	const app = express();
	app.use(express.json({ limit: "10mb" }));

	const traceRouter = express.Router();
	registerTraceRoutes(traceRouter, tracker);
	app.use("/__blok", traceRouter);

	return app;
}

/**
 * Start the Blok Studio server. Two modes:
 *
 *   1. **Proxy** (default when a trigger backend is reachable) — serves
 *      the SPA and proxies /__blok/* to the trigger HTTP server. Live
 *      data, real-time SSE.
 *
 *   2. **Standalone** (Prisma-Studio-style) — mounts /__blok/* on the
 *      same Express server using a RunTracker pointed at a SQLite file.
 *      Triggered by `--db <path>`, `--standalone`, or auto-detected
 *      from `.blok/trace.db` when no proxy backend is reachable. Lets
 *      operators inspect historical runs without spinning up the
 *      trigger + all 7 SDKs.
 */
export async function startStudio(options: StudioOptions): Promise<void> {
	const { port, url: backendUrl, open: shouldOpen } = options;

	p.intro(color.bgCyan(color.black(" Blok Studio ")));

	// Resolve Studio static assets
	const staticPath = resolveStaticPath();
	if (!staticPath) {
		p.log.error(`Studio assets not found.\n  Build them first: ${color.cyan("bun run --filter @blokjs/studio build")}`);
		process.exit(1);
	}

	// Decide mode
	let mode: "proxy" | "standalone" = "proxy";
	let dbPath: string | null = null;

	if (options.db) {
		mode = "standalone";
		dbPath = path.resolve(options.db);
	} else if (options.standalone) {
		mode = "standalone";
		dbPath = autoDetectDbPath() ?? path.resolve(process.cwd(), ".blok", "trace.db");
	} else {
		// Default: try the proxy first; fall back to standalone if no
		// backend is reachable AND a project-local trace.db exists.
		const s = p.spinner();
		s.start("Checking backend health...");
		const healthy = await checkBackendHealth(backendUrl);
		if (healthy) {
			s.stop(color.green("Backend healthy"));
		} else {
			const auto = autoDetectDbPath();
			if (auto) {
				s.stop(color.green(`Backend not reachable; serving from ${color.cyan(path.relative(process.cwd(), auto))}`));
				mode = "standalone";
				dbPath = auto;
			} else {
				s.stop(color.yellow("Backend not reachable"));
				p.log.warn(
					`Blok backend not found at ${color.cyan(backendUrl)}\n` +
						`  Start it first: ${color.cyan("blokctl dev")}\n` +
						`  Or open a trace file directly: ${color.cyan("blokctl studio --db <path>")}`,
				);
				p.log.info("Starting Studio anyway — it will connect when the backend is up.");
			}
		}
	}

	// Standalone: build the express backend
	let standaloneApp: express.Application | null = null;
	if (mode === "standalone" && dbPath) {
		try {
			standaloneApp = await buildStandaloneApp(dbPath);
			p.log.success(`Standalone mode · reading ${color.cyan(path.relative(process.cwd(), dbPath))}`);
		} catch (e) {
			p.log.error(
				`Failed to open trace file ${color.cyan(dbPath)}\n  ${(e as Error).message}\n` +
					`  Make sure better-sqlite3 is available: ${color.cyan("npm install better-sqlite3")}`,
			);
			process.exit(1);
		}
	}

	// Create HTTP server
	const server = http.createServer((req, res) => {
		const url = req.url || "/";

		if (url.startsWith("/__blok")) {
			if (standaloneApp) {
				// Standalone: hand off to express so the trace router gets
				// parsed params, headers, body parsing, etc.
				return standaloneApp(req as unknown as express.Request, res as unknown as express.Response);
			}
			// Proxy: forward to the live backend
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
			if (mode === "standalone" && dbPath) {
				p.log.info(`Standalone · ${color.dim(`reading ${path.relative(process.cwd(), dbPath)}`)}`);
			} else {
				p.log.info(`Proxying to backend at ${color.dim(backendUrl)}`);
			}
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
