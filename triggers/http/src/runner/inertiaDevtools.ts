import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { RouteEntry } from "./WorkflowRouter.js";

const INERTIA_PKG = "@blokjs/inertia";

interface DevtoolsModule {
	isDevtoolsEnabled(): boolean;
	handleDevtoolsRead(request: Request): Promise<Response | null>;
	recordDevtools(input: {
		request: Request;
		response: Response;
		route: { name: string | null; uri: string; action: string | null; actionSource?: { file: string; line: number } };
		serverTimingMs: number;
	}): Promise<Response>;
}

let loaded: DevtoolsModule | null | undefined;
let warned = false;

async function load(): Promise<DevtoolsModule | null> {
	if (loaded !== undefined) return loaded;
	try {
		const mod = (await import(INERTIA_PKG)) as Partial<DevtoolsModule>;
		loaded =
			typeof mod.isDevtoolsEnabled === "function" &&
			typeof mod.handleDevtoolsRead === "function" &&
			typeof mod.recordDevtools === "function"
				? (mod as DevtoolsModule)
				: null;
	} catch {
		loaded = null;
	}
	return loaded;
}

function workflowName(workflow: unknown, fallback: string): string {
	if (!workflow || typeof workflow !== "object") return fallback;
	const value = workflow as { name?: unknown; _config?: { name?: unknown } };
	return typeof value.name === "string"
		? value.name
		: typeof value._config?.name === "string"
			? value._config.name
			: fallback;
}

function sourceLine(file: string, name: string): number {
	try {
		const lines = readFileSync(file, "utf8").split("\n");
		const index = lines.findIndex((line) => line.includes(name));
		return index < 0 ? 1 : index + 1;
	} catch {
		return 1;
	}
}

/** Optional outer HTTP middleware; a missing `@blokjs/inertia` is a no-op. */
export function inertiaDevtools(routes: () => readonly RouteEntry[]): MiddlewareHandler {
	return async (c, next) => {
		const devtools = await load();
		if (!devtools || !devtools.isDevtoolsEnabled()) return next();

		const read = await devtools.handleDevtoolsRead(c.req.raw);
		if (read) {
			c.res = read;
			return;
		}

		let request = c.req.raw;
		try {
			request = request.clone();
		} catch {
			// An earlier app/session middleware consumed it; body capture reports streamed.
		}
		const started = performance.now();
		await next();
		try {
			const uri = routePath(c, -1);
			const method = c.req.method.toUpperCase();
			const match = routes().find(
				(route) => route.path === uri && (route.method === "ANY" || route.method.toUpperCase() === method),
			);
			const action = match ? workflowName(match.workflow, match.workflowKey) : null;
			c.res = await devtools.recordDevtools({
				request,
				response: c.res,
				route: {
					name: action,
					uri: match?.path ?? uri,
					action,
					...(match?.sourcePath
						? {
								actionSource: {
									file: match.sourcePath,
									line: sourceLine(match.sourcePath, action ?? match.workflowKey),
								},
							}
						: {}),
				},
				serverTimingMs: performance.now() - started,
			});
		} catch (error) {
			if (!warned) {
				warned = true;
				console.warn(
					`[blok][inertia] DevTools recorder failed; the application response was kept: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	};
}
