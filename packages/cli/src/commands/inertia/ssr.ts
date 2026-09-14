import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_URL = "http://127.0.0.1:13714";

export interface StartSsrOptions {
	runtime?: string;
	port?: string | number;
	host?: string;
	cluster?: boolean;
	/** Test/programmatic override; the CLI auto-detects the bundle. */
	bundle?: string;
	/** Test/programmatic override; defaults to `process.cwd()`. */
	cwd?: string;
}

function enabled(): boolean {
	return !["0", "false", "off", "no"].includes((process.env.BLOK_INERTIA_SSR_ENABLED ?? "true").toLowerCase());
}

function configuredUrl(cwd = process.cwd()): string {
	if (process.env.BLOK_SSR_URL?.trim()) return process.env.BLOK_SSR_URL.trim();
	const staticDir = process.env.BLOK_STATIC_DIR ?? "client/dist";
	try {
		const file = join(isAbsolute(staticDir) ? staticDir : resolve(cwd, staticDir), ".blok-ssr-url");
		return readFileSync(file, "utf8").trim() || DEFAULT_URL;
	} catch {
		return DEFAULT_URL;
	}
}

function endpoint(path: string, cwd = process.cwd()): string {
	const url = new URL(configuredUrl(cwd));
	url.pathname = path;
	url.search = "";
	url.hash = "";
	return url.toString();
}

function bundlePath(options: StartSsrOptions): string | null {
	const cwd = options.cwd ?? process.cwd();
	const explicit = options.bundle ?? process.env.BLOK_INERTIA_SSR_BUNDLE;
	if (explicit) {
		const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		return existsSync(path) ? path : null;
	}
	for (const candidate of [
		"client/dist-ssr/ssr.js",
		"client/dist-ssr/ssr.mjs",
		"client/dist/server/ssr.js",
		"client/dist/server/ssr.mjs",
		"bootstrap/ssr/ssr.js",
		"bootstrap/ssr/ssr.mjs",
	]) {
		const path = resolve(cwd, candidate);
		if (existsSync(path)) return path;
	}
	return null;
}

function portOf(value: string | number | undefined): number {
	const port = Number(value ?? 13714);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid SSR port: ${String(value)}`);
	return port;
}

/** Start the built Inertia SSR entry in the foreground. */
export async function startSsr(options: StartSsrOptions = {}): Promise<void> {
	if (!enabled()) throw new Error("Inertia SSR is disabled by BLOK_INERTIA_SSR_ENABLED.");
	const bundle = bundlePath(options);
	if (!bundle)
		throw new Error("Inertia SSR bundle not found. Build the client SSR entry or set BLOK_INERTIA_SSR_BUNDLE.");

	const runtime = options.runtime ?? process.env.BLOK_INERTIA_SSR_RUNTIME ?? "node";
	const ensureRuntime = ["1", "true", "on", "yes"].includes(
		(process.env.BLOK_INERTIA_SSR_ENSURE_RUNTIME_EXISTS ?? "false").toLowerCase(),
	);
	if (ensureRuntime && spawnSync(runtime, ["--version"], { stdio: "ignore" }).status !== 0) {
		throw new Error(`SSR runtime "${runtime}" could not be found.`);
	}

	const child = spawn(runtime, [bundle], {
		cwd: options.cwd ?? process.cwd(),
		stdio: "inherit",
		env: {
			...process.env,
			BLOK_SSR_PORT: String(portOf(options.port)),
			BLOK_SSR_HOST: options.host ?? "127.0.0.1",
			BLOK_SSR_CLUSTER: String(options.cluster === true),
		},
	});

	await new Promise<void>((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") resolvePromise();
			else reject(new Error(`Inertia SSR server exited with ${signal ?? `code ${String(code)}`}.`));
		});
	});
}

/** Return true only when the SSR server answers `{ status: "OK" }`. */
export async function checkSsr(cwd = process.cwd()): Promise<boolean> {
	try {
		const response = await fetch(endpoint("/health", cwd));
		const body = (await response.json()) as { status?: unknown };
		return response.ok && body.status === "OK";
	} catch {
		return false;
	}
}

/** Stop a healthy SSR server through the documented wire endpoint. */
export async function stopSsr(cwd = process.cwd()): Promise<void> {
	if (!(await checkSsr(cwd))) throw new Error("Inertia SSR server is not running.");
	// The upstream server exits inside the route handler, so a reset response is
	// a successful shutdown after the health probe above.
	await fetch(endpoint("/shutdown", cwd), { method: "POST" }).catch(() => undefined);
}
