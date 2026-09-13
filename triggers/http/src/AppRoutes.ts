/**
 * Hono sub-app used to define application routes.
 *
 * @remarks
 * This app is currently minimal. You can create routes by using methods like `app.get`, `app.post`, etc.
 * Example:
 * ```typescript
 * app.get('/example', (c) => {
 *   return c.text('Example route');
 * });
 * ```
 *
 * @module AppRoutes
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, Hono, type MiddlewareHandler } from "hono";
const app = new Hono();

/** Vite fingerprints every `/assets/*` filename, so they can be cached forever. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Name of the version file the Vite plugin writes into the client build. */
const ASSET_VERSION_FILE = ".blok-asset-version";

/**
 * #1000 — the host engine's `serveStatic`. Bun reads files through `Bun.file`
 * (`hono/bun`), Node through fs streams (`@hono/node-server/serve-static`).
 * Detection is the repo idiom — `"Bun" in globalThis`, same probe
 * `core/runner`'s `BunRuntimeAdapter` / `SqliteRunStore` use — rather than a
 * new one. The import is dynamic so the Bun adapter is never loaded on Node.
 */
async function hostServeStatic(): Promise<(options: { root: string }) => MiddlewareHandler> {
	const mod = "Bun" in globalThis ? await import("hono/bun") : await import("@hono/node-server/serve-static");
	return mod.serveStatic as (options: { root: string }) => MiddlewareHandler;
}

/** Registers the static routes for one prepared root onto a Hono app. */
type StaticMount = <E extends Env>(honoApp: Hono<E>) => void;

/**
 * #1000 — prepare the mount for a built client bundle (`BLOK_STATIC_DIR`,
 * e.g. `client/dist`). Loading the host adapter is async, registering routes
 * is not, so this resolves the adapter once at boot and hands back a plain
 * function the caller registers in route order.
 *
 * `/assets/*` is served immutable; `favicon.ico` and `robots.txt` come from
 * the same root with no cache header. Called from `HttpTrigger.listen()` only
 * when `BLOK_STATIC_DIR` is set — with it unset nothing is registered and the
 * welcome page below is still what `/` serves.
 */
export async function prepareStaticRoutes(root: string): Promise<StaticMount> {
	const serveStatic = await hostServeStatic();
	return <E extends Env>(honoApp: Hono<E>) => {
		const files = serveStatic({ root }) as MiddlewareHandler<E>;

		// Set AFTER the fact so a miss (the 404 below) never inherits the
		// year-long immutable header.
		honoApp.use("/assets/*", async (c, next) => {
			await next();
			if (c.res.status === 200) c.res.headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
		});
		honoApp.use("/assets/*", files);
		// `serveStatic` falls THROUGH on a miss (and on a rejected `..` path).
		// Without this the request would reach the workflow catch-all and come
		// back as a workflow 404 naming a workflow nobody asked for.
		honoApp.all("/assets/*", (c) => c.text("Not Found", 404));

		// Not fingerprinted → no cache header. Both fall through when absent.
		honoApp.get("/favicon.ico", files);
		honoApp.get("/robots.txt", files);
	};
}

/**
 * #1000 — the asset version written next to the client build by the Vite
 * plugin. `null` when the file is missing or empty (no build yet, or a static
 * dir that isn't a Blok client build).
 */
export function readAssetVersion(root: string): string | null {
	try {
		return readFileSync(join(root, ASSET_VERSION_FILE), "utf8").trim() || null;
	} catch {
		return null;
	}
}

app.get("/", (c) => {
	const html = `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Welcome to blok</title>
		<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
		<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
		<style>
			body { font-family: 'Inter', sans-serif; }
		</style>
	</head>
	<body class="bg-gray-50 text-gray-800 min-h-screen flex flex-col">
		<main class="grow flex items-center justify-center px-4">
			<div class="max-w-3xl bg-white shadow-xl rounded-2xl p-10 border border-gray-200">
				<h1 class="text-3xl font-semibold mb-6 text-center text-blue-700">🚀 Welcome to <span class="text-black">blok</span></h1>
				<p class="text-lg mb-4">You're ready to start building fast and modular applications. Here's how to get started:</p>
				<ol class="list-decimal list-inside mb-6 space-y-2 text-base text-gray-700">
					<li><strong>Create</strong> a new <strong>node</strong> using <code class="bg-gray-100 px-2 py-1 rounded">npx blokctl@latest create node</code>.</li>
					<li><strong>Create</strong> a new <strong>workflow</strong> using <code class="bg-gray-100 px-2 py-1 rounded">npx blokctl@latest create workflow</code>.</li>
					<li><strong>Extend</strong> the routing system in <code class="bg-gray-100 px-2 py-1 rounded">src/AppRoutes.ts</code> to expose new logic.</li>
					<li><strong>Initialize</strong> the metrics stack with Prometheus using <code class="bg-gray-100 px-2 py-1 rounded">docker compose -f infra/metrics/docker-compose.yml up</code>.</li>
					<li><strong>Start</strong> the Docker development environment by running <code class="bg-gray-100 px-2 py-1 rounded">npm run infra:dev</code>.</li>
					<li><strong>Start</strong> the TypeScript watcher to regenerate the dist folder by running <code class="bg-gray-100 px-2 py-1 rounded">npm run infra:build</code>.</li>
					<li><strong>Monitor</strong> built-in performance metrics with <code class="bg-gray-100 px-2 py-1 rounded">npx blokctl@latest monitor</code>.</li>
				</ol>

				<div class="mt-8 text-center">
					<a href="https://blok.build/" target="_blank" class="inline-block bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 transition">Explore Docs</a>
				</div>
			</div>
		</main>

		<footer class="text-center text-sm text-gray-500 py-4">
			<p>Made with ❤️ by the <a href="https://deskree.com/" target="_blank" class="text-blue-600 hover:underline">Deskree</a> team.</p>
		</footer>
	</body>
	</html>
	`;

	return c.html(html, 200);
});

export default app;
