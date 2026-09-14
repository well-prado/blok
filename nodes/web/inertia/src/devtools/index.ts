import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPageRegistry } from "../define-page.js";
import { type PageObject, headerList } from "../protocol.js";

const DEFAULT_REDACT = ["password", "token", "secret", "authorization", "cookie", "set-cookie"];
const DEFAULT_EXCEPT = ["/_inertia/devtools/*", "/__blok/*"];
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_LIMIT = 200;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type DevtoolsRequestType =
	| "precognition"
	| "initial"
	| "http"
	| "deferred"
	| "poll"
	| "partial"
	| "prefetch"
	| "navigate";

export type BodyCapture =
	| { status: "empty" }
	| { status: "present"; value: unknown }
	| {
			status: "omitted";
			reason:
				| "non-inertia-response"
				| "non-inertia-request"
				| "non-textual"
				| "streamed"
				| "too-large"
				| "unserializable"
				| "binary";
	  };

export interface SourceLocation {
	file: string;
	line: number;
}

export interface DevtoolsRoute {
	name: string | null;
	uri: string;
	action: string | null;
	actionSource?: SourceLocation;
}

export interface PropMeta {
	inertiaType?: "always" | "defer" | "optional" | "merge" | "scroll" | "once";
	shared?: boolean;
	deferGroup?: string;
	reset?: boolean;
	once?: boolean;
	mergeDirection?: "append" | "prepend";
	deepMerge?: boolean;
	rescued?: boolean;
	renderSource?: SourceLocation;
	shareSource?: SourceLocation;
}

export interface DevtoolsEntry {
	__meta: {
		id: string;
		method: string;
		url: string;
		status: number;
		requestType: DevtoolsRequestType;
		component: string | null;
		timestamp: string;
		utime: number;
		tabUuid: string | null;
		batchId: string | null;
		serverTimingMs: number | null;
		redirectLocation: string | null;
		visitId: string | null;
	};
	http: {
		requestHeaders: Record<string, string>;
		responseHeaders: Record<string, string>;
		requestBody: BodyCapture;
		responseBody: BodyCapture;
	};
	props: Record<string, PropMeta>;
	propValues: Record<string, unknown>;
	route: DevtoolsRoute;
	renderSource: SourceLocation | null;
	componentPath: string | null;
}

export interface DevtoolsOptions {
	redact?: string[];
	except?: string[];
	storagePath?: string;
	ttlMs?: number;
	limit?: number;
}

export interface RecordDevtoolsInput {
	request: Request;
	response: Response;
	route?: DevtoolsRoute;
	serverTimingMs?: number;
}

export type DevtoolsGate = (request: Request) => boolean | Promise<boolean>;

let configured: DevtoolsOptions = {};
const gates = new Map<string, DevtoolsGate>();
let indexedPath = "";
let index: Map<string, DevtoolsEntry> | undefined;
let writes = Promise.resolve();

/** Configure redaction, excluded paths, and local retention. */
export function configureDevtools(options: DevtoolsOptions): void {
	configured = { ...configured, ...options };
}

/** Register the policy named by `BLOK_INERTIA_DEVTOOLS_GATE`. */
export function defineDevtoolsGate(name: string, gate: DevtoolsGate): void {
	if (!name)
		throw new Error(
			'defineDevtoolsGate() requires a non-empty name. Fix: pass the same name you set in BLOK_INERTIA_DEVTOOLS_GATE, e.g. defineDevtoolsGate("admins", gate).',
		);
	gates.set(name, gate);
}

/** Reset process-wide configuration and gates. Test-only. */
export function _resetDevtools(): void {
	configured = {};
	gates.clear();
	indexedPath = "";
	index = undefined;
	writes = Promise.resolve();
}

function envBoolean(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	return value === undefined ? fallback : !["0", "false", "off", "no"].includes(value.toLowerCase());
}

/** The recorder defaults on outside production and may be explicitly overridden. */
export function isDevtoolsEnabled(): boolean {
	return envBoolean("BLOK_INERTIA_DEVTOOLS_ENABLED", process.env.NODE_ENV !== "production");
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function ttlMs(): number {
	if (configured.ttlMs !== undefined) return configured.ttlMs;
	const raw = process.env.BLOK_INERTIA_DEVTOOLS_TTL;
	if (!raw) return DEFAULT_TTL_MS;
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(raw.trim());
	if (!match) return DEFAULT_TTL_MS;
	const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
	return Number(match[1]) * units[match[2] ?? "s"];
}

function limit(): number {
	return configured.limit ?? positiveInt(process.env.BLOK_INERTIA_DEVTOOLS_LIMIT, DEFAULT_LIMIT);
}

function storagePath(): string {
	const path = configured.storagePath ?? process.env.BLOK_INERTIA_DEVTOOLS_PATH ?? ".blok/devtools";
	return isAbsolute(path) ? path : resolve(path);
}

function globMatches(pattern: string, path: string): boolean {
	const regex = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${regex}$`).test(path);
}

function excluded(path: string): boolean {
	return [...DEFAULT_EXCEPT, ...(configured.except ?? [])].some((pattern) => globMatches(pattern, path));
}

function encodeTime(time: number): string {
	let value = time;
	let out = "";
	for (let i = 0; i < 10; i++) {
		out = ALPHABET[value % 32] + out;
		value = Math.floor(value / 32);
	}
	return out;
}

function ulid(): string {
	const bytes = randomBytes(10);
	let bits = 0;
	let buffer = 0;
	let out = "";
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += ALPHABET[(buffer >> bits) & 31];
		}
	}
	return encodeTime(Date.now()) + out;
}

function headersOf(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

function sensitive(key: string): boolean {
	const lower = key.toLowerCase();
	return (configured.redact ?? DEFAULT_REDACT).some((part) => lower.includes(part.toLowerCase()));
}

function redactTree(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
	if (key && sensitive(key)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map((item) => redactTree(item, "", seen));
	if (value && typeof value === "object") {
		if (seen.has(value)) throw new TypeError("circular value");
		seen.add(value);
		const out: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
			out[childKey] = redactTree(child, childKey, seen);
		}
		seen.delete(value);
		return out;
	}
	if (["bigint", "function", "symbol"].includes(typeof value)) throw new TypeError("unserializable value");
	return value;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key, sensitive(key) ? "[REDACTED]" : value]),
	);
}

function isTextual(contentType: string): boolean {
	return /^(?:text\/|application\/(?:json|.+\+json|xml|.+\+xml|x-www-form-urlencoded))/.test(contentType);
}

function isBinary(contentType: string): boolean {
	return /^(?:application\/(?:octet-stream|pdf|zip)|audio\/|image\/|video\/)/.test(contentType);
}

function parsedValue(text: string, contentType: string): unknown {
	if (contentType.includes("json")) return JSON.parse(text);
	return text;
}

async function requestBody(request: Request): Promise<BodyCapture> {
	if (["GET", "HEAD"].includes(request.method.toUpperCase()) || request.body === null) return { status: "empty" };
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (positiveInt(request.headers.get("content-length") ?? undefined, 0) > MAX_BODY_BYTES) {
		return { status: "omitted", reason: "too-large" };
	}
	if (isBinary(contentType) || contentType.startsWith("multipart/")) return { status: "omitted", reason: "binary" };
	if (!isTextual(contentType)) return { status: "omitted", reason: "non-textual" };
	try {
		const text = await request.text();
		if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { status: "omitted", reason: "too-large" };
		if (!text) return { status: "empty" };
		if (request.headers.get("x-inertia") !== "true" && !request.headers.has("precognition")) {
			return { status: "omitted", reason: "non-inertia-request" };
		}
		try {
			return { status: "present", value: redactTree(parsedValue(text, contentType)) };
		} catch (error) {
			return error instanceof SyntaxError
				? { status: "present", value: text }
				: { status: "omitted", reason: "unserializable" };
		}
	} catch {
		return { status: "omitted", reason: "streamed" };
	}
}

function pageFromHtml(html: string): PageObject | null {
	const match = /<script\b[^>]*\bdata-page(?:=(?:"[^"]*"|'[^']*'))?[^>]*>([\s\S]*?)<\/script>/i.exec(html);
	try {
		if (match) return pageObject(JSON.parse(match[1] ?? ""));
		const attribute = /\bdata-page=(?:"([^"]*)"|'([^']*)')/i.exec(html)?.slice(1).find(Boolean);
		if (!attribute) return null;
		return pageObject(
			JSON.parse(
				attribute
					.replace(/&quot;/g, '"')
					.replace(/&#39;|&apos;/g, "'")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&amp;/g, "&"),
			),
		);
	} catch {
		return null;
	}
}

function pageObject(value: unknown): PageObject | null {
	if (!value || typeof value !== "object") return null;
	const page = value as Partial<PageObject>;
	return typeof page.component === "string" && page.props && typeof page.props === "object"
		? (page as PageObject)
		: null;
}

async function responseBody(
	response: Response,
	inertiaRequest: boolean,
): Promise<{ capture: BodyCapture; page: PageObject | null }> {
	if (response.body === null) return { capture: { status: "empty" }, page: null };
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	const inertiaResponse = response.headers.get("x-inertia") === "true";
	const html = contentType.startsWith("text/html");
	if (positiveInt(response.headers.get("content-length") ?? undefined, 0) > MAX_BODY_BYTES) {
		return { capture: { status: "omitted", reason: "too-large" }, page: null };
	}
	if (isBinary(contentType)) return { capture: { status: "omitted", reason: "binary" }, page: null };
	if (!isTextual(contentType)) return { capture: { status: "omitted", reason: "non-textual" }, page: null };
	try {
		const text = await response.clone().text();
		if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
			return { capture: { status: "omitted", reason: "too-large" }, page: null };
		}
		if (!text) return { capture: { status: "empty" }, page: null };
		if (!inertiaResponse && !html) {
			return { capture: { status: "omitted", reason: "non-inertia-response" }, page: null };
		}
		try {
			const value = html ? text : parsedValue(text, contentType);
			const page = html ? pageFromHtml(text) : pageObject(value);
			if (!inertiaRequest && !page) {
				return { capture: { status: "omitted", reason: "non-inertia-response" }, page: null };
			}
			return { capture: { status: "present", value: redactTree(value) }, page };
		} catch (error) {
			return error instanceof SyntaxError
				? { capture: { status: "present", value: text }, page: null }
				: { capture: { status: "omitted", reason: "unserializable" }, page: null };
		}
	} catch {
		return { capture: { status: "omitted", reason: "streamed" }, page: null };
	}
}

/** Protocol request-type precedence, evaluated top to bottom. */
export function deriveRequestType(headers: Headers, component: string | null): DevtoolsRequestType {
	if (headers.has("precognition")) return "precognition";
	if (headers.get("x-inertia") !== "true") return component ? "initial" : "http";
	if (headers.has("x-inertia-devtools-deferred")) return "deferred";
	if (headers.has("x-inertia-devtools-poll")) return "poll";
	if (headers.has("x-inertia-partial-component")) return "partial";
	if (headers.get("purpose")?.toLowerCase() === "prefetch") return "prefetch";
	return "navigate";
}

function includesProp(paths: readonly string[] | undefined, key: string): boolean {
	return paths?.some((path) => path === key || path.startsWith(`${key}.`)) === true;
}

function propMetadata(page: PageObject | null, request: Request): Record<string, PropMeta> {
	if (!page) return {};
	const declared = getPageRegistry().get(page.component);
	const deferred = Object.entries(page.deferredProps ?? {});
	const keys = new Set([
		...Object.keys(page.props),
		...Object.keys(declared?.props ?? {}),
		...deferred.flatMap(([, names]) => names),
		...(page.rescuedProps ?? []),
		...(page.sharedProps ?? []),
	]);
	const reset = new Set(headerList(request.headers.get("x-inertia-reset") ?? undefined));
	const out: Record<string, PropMeta> = {};
	for (const key of keys) {
		const registration = declared?.props[key];
		const prepend = includesProp(page.prependProps, key);
		const append = includesProp(page.mergeProps, key) || includesProp(page.deepMergeProps, key);
		const scroll = page.scrollProps?.[key];
		const once = Object.values(page.onceProps ?? {}).some((entry) => entry.prop === key);
		const deferGroup = deferred.find(([, names]) => names.includes(key))?.[0] ?? registration?.group;
		const inferred = scroll
			? "scroll"
			: once
				? "once"
				: deferGroup
					? "defer"
					: prepend || append
						? "merge"
						: includesProp(page.sharedProps, key) &&
								includesProp((page as PageObject & { alwaysProps?: string[] }).alwaysProps, key)
							? "always"
							: undefined;
		const registeredType = registration?.mode === "regular" ? undefined : registration?.mode;
		out[key] = {
			...(registeredType || inferred ? { inertiaType: (registeredType ?? inferred) as PropMeta["inertiaType"] } : {}),
			shared: includesProp(page.sharedProps, key),
			...(deferGroup ? { deferGroup } : {}),
			...(reset.has(key) || scroll?.reset === true ? { reset: true } : {}),
			...(once || registration?.mode === "once" ? { once: true } : {}),
			...(prepend || append ? { mergeDirection: prepend ? "prepend" : "append" } : {}),
			...(includesProp(page.deepMergeProps, key) ? { deepMerge: true } : {}),
			...(page.rescuedProps?.includes(key) ? { rescued: true } : {}),
			...(registration?.source ? { renderSource: registration.source } : {}),
		};
	}
	return out;
}

function componentPath(component: string | null): string | null {
	if (!component) return null;
	const staticDir = resolve(process.env.BLOK_STATIC_DIR ?? "client/dist");
	try {
		const manifest = JSON.parse(readFileSync(join(staticDir, "pages.json"), "utf8")) as { root?: unknown };
		if (typeof manifest.root !== "string" || !manifest.root) return null;
		const pageRoot = resolve(dirname(staticDir), manifest.root);
		for (const extension of [".tsx", ".jsx", ".vue", ".svelte", ".ts", ".js"]) {
			const file = join(pageRoot, component + extension);
			if (existsSync(file)) return relative(process.cwd(), file).replace(/\\/g, "/");
		}
	} catch {
		return null;
	}
	return null;
}

function entryFile(id: string): string {
	return join(storagePath(), `${id}.json`);
}

async function storedEntries(): Promise<DevtoolsEntry[]> {
	const dir = storagePath();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	if (!index || indexedPath !== dir) {
		indexedPath = dir;
		index = new Map();
		for (const name of await readdir(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as DevtoolsEntry;
				index.set(entry.__meta.id, entry);
			} catch {
				// Ignore incomplete or foreign files; only valid entries are indexed.
			}
		}
	}
	const now = Date.now();
	for (const entry of index.values()) {
		if (now - entry.__meta.utime * 1_000 <= ttlMs()) continue;
		index.delete(entry.__meta.id);
		await unlink(entryFile(entry.__meta.id)).catch(() => undefined);
	}
	return [...index.values()].sort((a, b) => b.__meta.utime - a.__meta.utime);
}

async function storeNow(entry: DevtoolsEntry): Promise<void> {
	await storedEntries();
	const file = entryFile(entry.__meta.id);
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
	await rename(temporary, file);
	index?.set(entry.__meta.id, entry);
	const sameTab = [...(index?.values() ?? [])]
		.filter((candidate) => candidate.__meta.tabUuid === entry.__meta.tabUuid)
		.sort((a, b) => b.__meta.utime - a.__meta.utime);
	await Promise.all(
		sameTab.slice(limit()).map((candidate) => {
			index?.delete(candidate.__meta.id);
			return unlink(entryFile(candidate.__meta.id)).catch(() => undefined);
		}),
	);
}

function store(entry: DevtoolsEntry): Promise<void> {
	const pending = writes.then(() => storeNow(entry));
	writes = pending.catch(() => undefined);
	return pending;
}

async function getEntry(id: string): Promise<DevtoolsEntry | null> {
	if (!ULID_RE.test(id)) return null;
	return (await storedEntries()).find((entry) => entry.__meta.id === id) ?? null;
}

function discovery(response: Response, id: string, initial: boolean): Promise<Response> | Response {
	response.headers.set("X-Inertia-Devtools-Id", id);
	return initial
		? response.text().then((html) => {
				const tag = `<script data-inertia-devtools-id type="application/json">${JSON.stringify(id)}</script>`;
				const body = html.includes("</body>") ? html.replace("</body>", `${tag}\n</body>`) : `${html}${tag}`;
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			})
		: response;
}

/** Record a finished response and return it with discovery/correlation headers. */
export async function recordDevtools({
	request,
	response,
	route = { name: null, uri: "", action: null },
	serverTimingMs,
}: RecordDevtoolsInput): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (!isDevtoolsEnabled() || excluded(path)) return response;

	const id = ulid();
	// #1051 — buffer the body ONCE and rebuild the response from the buffer.
	// Bun does not leave the original readable after a clone has been consumed,
	// so inspecting the body and then returning the same `response` shipped an
	// empty 200 for every Inertia XHR — i.e. every SPA navigation in dev.
	const buffered = response.body === null ? null : await response.arrayBuffer();
	const carried = (): Response =>
		new Response(buffered, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	const inspected = await responseBody(carried(), request.headers.get("x-inertia") === "true");
	const page = inspected.page;
	const requestType = deriveRequestType(request.headers, page?.component ?? null);
	const parent = request.headers.get("x-inertia-devtools-parent");
	const parentOut = requestType === "prefetch" ? id : (parent ?? id);
	response.headers.set("X-Inertia-Devtools-Parent-Out", parentOut);
	response.headers.set("X-Inertia-Devtools-Id", id);

	const now = performance.timeOrigin + performance.now();
	const pageRegistration = page ? getPageRegistry().get(page.component) : undefined;
	const entry: DevtoolsEntry = {
		__meta: {
			id,
			method: request.method,
			url: request.url,
			status: response.status,
			requestType,
			component: page?.component ?? null,
			timestamp: new Date(now).toISOString(),
			utime: now / 1_000,
			tabUuid: request.headers.get("x-inertia-devtools-tab"),
			batchId: parent,
			serverTimingMs: serverTimingMs ?? null,
			redirectLocation:
				response.headers.get("location") ??
				response.headers.get("x-inertia-location") ??
				response.headers.get("x-inertia-redirect"),
			visitId: request.headers.get("x-inertia-devtools-visit"),
		},
		http: {
			requestHeaders: redactHeaders(headersOf(request.headers)),
			responseHeaders: redactHeaders(headersOf(response.headers)),
			requestBody: await requestBody(request),
			responseBody: inspected.capture,
		},
		props: propMetadata(page, request),
		propValues: (page ? redactTree(page.props) : {}) as Record<string, unknown>,
		route,
		renderSource: pageRegistration?.source ?? null,
		componentPath: componentPath(page?.component ?? null),
	};
	await store(entry);
	return await discovery(carried(), id, requestType === "initial");
}

async function authorizeRead(request: Request): Promise<boolean> {
	if (process.env.NODE_ENV !== "production" && process.env.BLOK_ENV !== "production") return true;
	const name = process.env.BLOK_INERTIA_DEVTOOLS_GATE;
	const gate = name ? gates.get(name) : undefined;
	try {
		return gate ? await gate(request) : false;
	} catch {
		return false;
	}
}

/** Handle one fixed DevTools read endpoint, or return `null` for any other path. */
export async function handleDevtoolsRead(request: Request): Promise<Response | null> {
	if (!isDevtoolsEnabled() || request.method !== "GET") return null;
	const url = new URL(request.url);
	const match = /^\/_inertia\/devtools\/entries(?:\/([^/]+))?$/.exec(url.pathname);
	if (!match) return null;
	if (!(await authorizeRead(request))) return Response.json({ error: "Forbidden" }, { status: 403 });

	if (match[1]) {
		const entry = await getEntry(match[1]);
		return entry ? Response.json(entry) : Response.json({ error: "Not found" }, { status: 404 });
	}
	const components = url.searchParams.get("component");
	const types = new Set((url.searchParams.get("type") ?? "").split(",").filter(Boolean));
	const excludedTypes = new Set((url.searchParams.get("exclude") ?? "").split(",").filter(Boolean));
	const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
	const requestedLimit = Math.max(0, Number(url.searchParams.get("limit")) || limit());
	const entries = (await storedEntries()).filter(
		(entry) =>
			(!components || entry.__meta.component === components) &&
			(types.size === 0 || types.has(entry.__meta.requestType)) &&
			!excludedTypes.has(entry.__meta.requestType),
	);
	return Response.json(entries.slice(offset, offset + requestedLimit));
}
