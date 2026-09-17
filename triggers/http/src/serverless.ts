import type { AppBindings } from "./runner/HttpTrigger.js";
import HttpTrigger from "./runner/HttpTrigger.js";

/** The smallest lifecycle surface required by a function adapter. */
export interface ServerlessHttpTrigger {
	prepare(mode?: "server" | "serverless"): Promise<unknown>;
	fetch(request: Request, env?: AppBindings["Bindings"]): Promise<Response>;
}

export interface ServerlessHandlerOptions {
	/**
	 * Injection point for tests and framework integrations. The default creates
	 * one HttpTrigger when the module is loaded and reuses it while warm.
	 */
	readonly createTrigger?: () => ServerlessHttpTrigger;
	/** Optional structured logger; defaults to console.error. */
	readonly logError?: (event: string, error: unknown) => void;
}

export type ServerlessHandler = (request: Request) => Promise<Response>;
export type ServerlessTriggerFactory = () => ServerlessHttpTrigger;

function errorDetails(error: unknown): { name: string; message: string } {
	if (error instanceof Error) return { name: error.name || "Error", message: error.message };
	return { name: "Error", message: String(error) };
}

function defaultErrorLogger(event: string, error: unknown): void {
	const details = errorDetails(error);
	// Keep logs structured while avoiding an exception object that some
	// providers serialize with request headers or other ambient context.
	console.error(JSON.stringify({ event, error: details }));
}

/**
 * Create a Vercel-compatible Web Fetch handler.
 *
 * This module deliberately imports only HttpTrigger and its runtime graph. It
 * does not import the CLI, the process entrypoint, @hono/node-server's
 * listener, or any development server. The trigger owns preparation's
 * single-flight promise; this wrapper adds the provider-facing error boundary
 * and preserves the original Request/Response objects (including streams).
 */
export function createVercelHandler(options: ServerlessHandlerOptions = {}): ServerlessHandler {
	let trigger: ServerlessHttpTrigger | undefined;
	let preparation: Promise<void> | undefined;
	const createTrigger = options.createTrigger ?? (() => new HttpTrigger());
	const logError = options.logError ?? defaultErrorLogger;

	function getTrigger(): ServerlessHttpTrigger {
		if (!trigger) trigger = createTrigger();
		return trigger;
	}

	function prepare(): Promise<void> {
		if (!preparation) {
			preparation = getTrigger()
				.prepare("serverless")
				.then(() => undefined)
				.catch((error: unknown) => {
					// Do not leave the adapter permanently wedged after a transient
					// cold-start failure. HttpTrigger also clears its own rejected
					// single-flight promise per ADR 0018.
					preparation = undefined;
					throw error;
				});
		}
		return preparation;
	}

	return async (request: Request): Promise<Response> => {
		try {
			await prepare();
		} catch (error: unknown) {
			const details = errorDetails(error);
			logError("blok.serverless.initialization_failed", error);
			return Response.json(
				{
					error: "BLOK serverless initialization failed",
					code: "BLOK_SERVERLESS_INIT_FAILED",
					failure: details.name,
				},
				{ status: 503 },
			);
		}

		try {
			return await getTrigger().fetch(request);
		} catch (error: unknown) {
			logError("blok.serverless.request_failed", error);
			return Response.json(
				{
					error: "BLOK serverless request failed",
					code: "BLOK_SERVERLESS_REQUEST_FAILED",
					failure: errorDetails(error).name,
				},
				{ status: 500 },
			);
		}
	};
}

/**
 * Friendly name used by generated Vercel `api/index.ts` files. Accepting a
 * factory keeps the generated entrypoint free to provide its own trigger
 * subclass while preserving the default HttpTrigger path.
 */
export function createBlokVercelHandler(
	factoryOrOptions: ServerlessTriggerFactory | ServerlessHandlerOptions = {},
): ServerlessHandler {
	return createVercelHandler(
		typeof factoryOrOptions === "function" ? { createTrigger: factoryOrOptions } : factoryOrOptions,
	);
}

/** Default `api/index.ts`-compatible export for a Node.js Vercel function. */
const handler = createVercelHandler();

export default handler;
