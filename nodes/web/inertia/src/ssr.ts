import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { GlobalError } from "@blokjs/shared";
import type { PageObject } from "./protocol.js";

const DEFAULT_URL = "http://127.0.0.1:13714/render";
const DEV_ENDPOINT = "/__inertia_ssr";

export type SsrErrorType = "browser-api" | "component-resolution" | "render" | "connection";

export interface SsrOptions {
	/** Enable SSR. Defaults to `BLOK_INERTIA_SSR_ENABLED !== "false"`. */
	enabled?: boolean;
	/** Render endpoint or SSR server base URL. */
	url?: string;
	/** Built SSR entry used by the existence check. */
	bundle?: string;
	/** Request-path globs that should always use client rendering. */
	withoutSsr?: string[];
	/** Skip production dispatch when no SSR bundle exists. Default `true`. */
	ensureBundleExists?: boolean;
	/** Surface SSR failures as HTTP 500s. Intended for tests only. */
	throwOnError?: boolean;
	/** Render request timeout. Default 2 seconds. */
	timeoutMs?: number;
}

declare module "./define-page.js" {
	interface RenderOptions {
		/** Enable or override SSR for this render. */
		ssr?: boolean | SsrOptions;
	}
}

export interface SsrRenderFailed {
	page: PageObject;
	error: string;
	type: SsrErrorType;
	hint?: string;
	timestamp?: string;
	browserApi?: string;
	component?: string;
	url?: string;
	stack?: string;
	sourceLocation?: unknown;
}

export interface SsrRenderResult {
	head: string[];
	body: string;
}

type DisableCondition = boolean | (() => boolean);
type FailureListener = (event: SsrRenderFailed) => void;

let configured: SsrOptions = {};
let disabled: DisableCondition | undefined;
let excluded: string[] = [];
let listeners = new Set<FailureListener>();
const warned = new Set<string>();

/** Set app-wide SSR defaults. A page's `ssr` input wins over these values. */
export function configureSsr(options: SsrOptions): void {
	configured = { ...configured, ...options };
}

/** Disable SSR globally or while a zero-argument condition returns true. */
export function disableSsr(condition: DisableCondition = true): void {
	disabled = condition;
}

/** Exclude request paths from SSR (`admin/*`, `dashboard`, etc.). */
export function withoutSsr(paths: string | string[]): void {
	excluded.push(...(Array.isArray(paths) ? paths : [paths]));
}

/** Subscribe to SSR failures. Returns an unsubscribe function. */
export function onSsrRenderFailed(listener: FailureListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test-only reset for process-wide adapter state and once-only warnings. */
export function _resetSsr(): void {
	configured = {};
	disabled = undefined;
	excluded = [];
	listeners = new Set();
	warned.clear();
}

function booleanEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	return value === undefined ? fallback : !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function optionsFor(overrides: boolean | SsrOptions | undefined): SsrOptions {
	const input = typeof overrides === "boolean" ? { enabled: overrides } : (overrides ?? {});
	return {
		enabled: booleanEnv("BLOK_INERTIA_SSR_ENABLED", true),
		ensureBundleExists: booleanEnv("BLOK_INERTIA_SSR_ENSURE_BUNDLE_EXISTS", true),
		throwOnError: booleanEnv("BLOK_INERTIA_SSR_THROW_ON_ERROR", false),
		timeoutMs: Number(process.env.BLOK_INERTIA_SSR_TIMEOUT_MS) || 2_000,
		...configured,
		...input,
	};
}

function endpoint(option: string | undefined): string | null {
	if (option !== undefined) return option.trim() || null;
	if (process.env.BLOK_SSR_URL !== undefined) return process.env.BLOK_SSR_URL.trim() || null;

	const dir = process.env.BLOK_STATIC_DIR ?? "client/dist";
	try {
		const value = readFileSync(join(isAbsolute(dir) ? dir : resolve(dir), ".blok-ssr-url"), "utf8").trim();
		return value || null;
	} catch {
		return DEFAULT_URL;
	}
}

function renderUrl(raw: string): string {
	const url = new URL(raw);
	if (url.pathname === "/" || url.pathname === "") url.pathname = "/render";
	return url.toString();
}

function bundleExists(bundle: string | undefined): boolean {
	const explicit = bundle ?? process.env.BLOK_INERTIA_SSR_BUNDLE;
	if (explicit) return existsSync(isAbsolute(explicit) ? explicit : resolve(explicit));
	return [
		"client/dist-ssr/ssr.js",
		"client/dist-ssr/ssr.mjs",
		"client/dist/server/ssr.js",
		"client/dist/server/ssr.mjs",
		"bootstrap/ssr/ssr.js",
		"bootstrap/ssr/ssr.mjs",
	].some((candidate) => existsSync(resolve(candidate)));
}

function pathOf(url: string): string {
	try {
		return new URL(url, "http://blok.local").pathname.replace(/^\/+/, "");
	} catch {
		return url.split("?")[0]?.replace(/^\/+/, "") ?? "";
	}
}

function globMatches(pattern: string, path: string): boolean {
	const regex = pattern
		.replace(/^\/+/, "")
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${regex}$`).test(path);
}

function shouldSkip(url: string, options: SsrOptions): boolean {
	if (options.enabled === false) return true;
	if (typeof disabled === "function" ? disabled() : disabled === true) return true;
	const path = pathOf(url);
	return [...excluded, ...(options.withoutSsr ?? [])].some((pattern) => globMatches(pattern, path));
}

function failureFrom(page: PageObject, value: unknown, fallbackType: SsrErrorType): SsrRenderFailed {
	const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const type = ["browser-api", "component-resolution", "render", "connection"].includes(String(body.type))
		? (body.type as SsrErrorType)
		: fallbackType;
	return {
		page,
		error: typeof body.error === "string" ? body.error : "Unknown SSR error",
		type,
		timestamp: typeof body.timestamp === "string" ? body.timestamp : new Date().toISOString(),
		component: typeof body.component === "string" ? body.component : page.component,
		url: typeof body.url === "string" ? body.url : page.url,
		...(typeof body.hint === "string" ? { hint: body.hint } : {}),
		...(typeof body.browserApi === "string" ? { browserApi: body.browserApi } : {}),
		...(typeof body.stack === "string" ? { stack: body.stack } : {}),
		...(body.sourceLocation !== undefined ? { sourceLocation: body.sourceLocation } : {}),
	};
}

function reportFailure(ctx: unknown, event: SsrRenderFailed, throwOnError: boolean): null {
	for (const listener of listeners) listener(event);
	(ctx as { publish?: (name: string, value: unknown) => void } | undefined)?.publish?.("SsrRenderFailed", event);

	const key = `${process.env.ASSET_VERSION ?? event.page.version}\0${event.page.component}`;
	if (!warned.has(key)) {
		warned.add(key);
		const logger = (ctx as { logger?: { logLevel?: (level: string, message: string) => void } } | undefined)?.logger;
		logger?.logLevel?.(
			"warn",
			`[blok] @blokjs/inertia: SSR failed for "${event.page.component}" (${event.type}): ${event.error}. Falling back to client rendering.`,
		);
	}

	if (throwOnError) {
		const error = new GlobalError(event.error);
		error.setName("SsrRenderFailed");
		error.setCode(500);
		error.setJson(event as unknown as Record<string, unknown>);
		throw error;
	}
	return null;
}

/** Render one initial page through the Inertia v3 SSR HTTP contract. */
export async function renderSsr(
	ctx: unknown,
	page: PageObject,
	overrides?: boolean | SsrOptions,
): Promise<SsrRenderResult | null> {
	const options = optionsFor(overrides);
	if (shouldSkip(page.url, options)) return null;

	const rawUrl = endpoint(options.url);
	if (!rawUrl) return null;
	const url = renderUrl(rawUrl);
	if (options.ensureBundleExists !== false && new URL(url).pathname !== DEV_ENDPOINT && !bundleExists(options.bundle)) {
		return null;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(page),
			signal: controller.signal,
		});
		const body = await response.json().catch(() => null);
		if (!response.ok) return reportFailure(ctx, failureFrom(page, body, "render"), options.throwOnError === true);
		if (!body || typeof body !== "object") {
			return reportFailure(
				ctx,
				failureFrom(page, { error: "SSR server returned an empty response", type: "render" }, "render"),
				options.throwOnError === true,
			);
		}
		const result = body as Record<string, unknown>;
		if (
			!Array.isArray(result.head) ||
			!result.head.every((item) => typeof item === "string") ||
			typeof result.body !== "string"
		) {
			return reportFailure(
				ctx,
				failureFrom(
					page,
					{ error: "SSR server must return { head: string[], body: string }", type: "render" },
					"render",
				),
				options.throwOnError === true,
			);
		}
		return { head: result.head, body: result.body } as SsrRenderResult;
	} catch (error) {
		if (error instanceof GlobalError) throw error;
		return reportFailure(
			ctx,
			failureFrom(
				page,
				{ error: error instanceof Error ? error.message : String(error), type: "connection" },
				"connection",
			),
			options.throwOnError === true,
		);
	} finally {
		clearTimeout(timer);
	}
}
