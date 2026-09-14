/**
 * `runPage()` — the Inertia page-workflow test harness (#1002).
 *
 * A page workflow's whole contract is a PROTOCOL: which headers went out, which
 * props the runner therefore resolved, and what the page object says about the
 * ones it did not. `runWorkflow` can already drive it, but every test then
 * re-types the same six headers and digs the page object out of a
 * `RespondEnvelope` by hand.
 *
 * So this is a thin wrapper, not a second engine: it builds the request, calls
 * `runWorkflow`, unwraps the envelope, and hands back the page plus a fluent
 * assertion object modelled on Laravel's `AssertableInertia`. Mocks, Zod
 * validation of those mocks, step introspection and `ctx.state` all come from
 * `runWorkflow` unchanged — `page.run` IS its result.
 *
 * The follow-up reloads (`reloadOnly` / `reloadExcept` / `loadDeferredProps`)
 * are REAL second runs of the same workflow with the partial-reload headers the
 * client would have sent, not a filter over the first response: that is the only
 * way a test can prove a deferred prop's node ran exactly when it should have.
 *
 * @example
 * const page = await runPage(ordersIndex, { middleware: { auth: { id: "u-1" } } });
 * page.assert().component("Orders/Index").has("orders", 2).etc();
 * await page.loadDeferredProps("dashboard", (p) => p.has("stats"));
 */

import { isDeepStrictEqual } from "node:util";
import { type RunWorkflowOptions, type WorkflowRun, runWorkflow } from "@blokjs/runner/testing";
import type { RespondEnvelope } from "@blokjs/shared";
import { FLASH_COOKIE, isRespondEnvelope, readCookie, verifyFlash } from "@blokjs/shared";

// =============================================================================
// Options
// =============================================================================

export interface RunPageOptions extends RunWorkflowOptions {
	/** Trigger payload — `ctx.request.body`, exactly like `runWorkflow`'s second argument. */
	input?: unknown;
	/**
	 * Partial-reload `only` keys. Sets `X-Inertia-Partial-Data` AND
	 * `X-Inertia-Partial-Component` (the page's own component — a partial naming
	 * a different one is a full visit).
	 */
	partial?: readonly string[] | string;
	/** Partial-reload `except` keys → `X-Inertia-Partial-Except` (+ the partial component). */
	except?: readonly string[] | string;
	/** Merge-prop paths the client wants replaced wholesale → `X-Inertia-Reset`. */
	reset?: readonly string[] | string;
	/** Asset version the client holds → `X-Inertia-Version`. */
	version?: string;
	/** Asset version the client holds, overriding {@link RunPageOptions.version} — pass a stale one to assert the 409. */
	clientVersion?: string;
	/**
	 * `ctx.state` slots seeded before the run — what a middleware chain would
	 * have left behind, so `shared(currentUser, "auth")` resolves.
	 *
	 * It does NOT execute middleware. To exercise the real chain, author it on
	 * the workflow and use `runWorkflow`.
	 */
	middleware?: Record<string, unknown>;
	/**
	 * Secret for the signed flash cookie (`assertFlash`). Defaults to
	 * `process.env.BLOK_FLASH_SECRET`.
	 */
	flashSecret?: string;
}

// =============================================================================
// Result
// =============================================================================

/** A scope callback: assert inside a nested prop, or inside a follow-up reload. */
export type PageScope = (page: AssertablePage) => void;

export interface PageResult<TProps = Record<string, unknown>> {
	/** Page component name. `undefined` when the workflow ended in a redirect/location. */
	readonly component?: string;
	/** The page object's props (`errors` included). `{}` for a redirect. */
	readonly props: TProps;
	/** Page-object `url`. */
	readonly url?: string;
	/** Page-object `version`. */
	readonly version?: string;
	/** Every announced deferred prop key, flattened across groups. */
	readonly deferred: string[];
	/** Deferred props by group, verbatim from the page object. */
	readonly deferredProps: Record<string, string[]>;
	/** Props whose resolution failed and were rescued. */
	readonly rescued: string[];
	readonly mergeProps: string[];
	readonly prependProps: string[];
	readonly deepMergeProps: string[];
	readonly matchPropsOn: string[];
	readonly onceProps: Record<string, unknown>;
	readonly scrollProps: Record<string, unknown>;
	/** Flash data: the page object's `flash`, plus `errors` when the page carries them. */
	readonly flash: Record<string, unknown>;
	/** HTTP status from the envelope (200 by default). */
	readonly status: number;
	/** Envelope response headers, verbatim (`X-Inertia`, `Vary`, `Location`, …). */
	readonly headers: Record<string, string>;
	/** Raw `Set-Cookie` values on the envelope. */
	readonly cookies: string[];
	/** `Location` / `X-Inertia-Location` / `X-Inertia-Redirect`, whichever the response carries. */
	readonly location?: string;
	/** The raw envelope body — the page object on an Inertia visit. */
	readonly body: unknown;
	/** The underlying `runWorkflow` result: steps, `ctx.state`, mocks, errors. */
	readonly run: WorkflowRun;

	/** Fluent page assertions (component / has / where / missing / etc / flash). */
	assert(): AssertablePage;
	/** Assert this run ended in a redirect (optionally to `url`). */
	assertRedirect(url?: string): AssertableRedirect;

	/** Re-run the workflow as a partial reload of `keys`. */
	reloadOnly(keys: readonly string[] | string, scope?: PageScope): Promise<PageResult<TProps>>;
	/** Re-run the workflow as a partial reload of everything but `keys`. */
	reloadExcept(keys: readonly string[] | string, scope?: PageScope): Promise<PageResult<TProps>>;
	/** Re-run the workflow asking for the deferred prop group(s) this page announced. */
	loadDeferredProps(groups: readonly string[] | string, scope?: PageScope): Promise<PageResult<TProps>>;
}

/** Fluent assertions over one page (or one nested prop scope). */
export interface AssertablePage {
	/** The page's component name. */
	component(name: string): AssertablePage;
	/** The prop at `key` (dot path) exists. */
	has(key: string): AssertablePage;
	/** The prop at `key` is an array/object of exactly `count` entries. */
	has(key: string, count: number): AssertablePage;
	/** The prop at `key` exists; assert inside it (exhaustively — see {@link AssertablePage.etc}). */
	has(key: string, scope: PageScope): AssertablePage;
	/** Both of the above at once. */
	has(key: string, count: number, scope: PageScope): AssertablePage;
	/** The value at `key` deep-equals `value`. */
	where(key: string, value: unknown): AssertablePage;
	/** Nothing lives at `key`. */
	missing(key: string): AssertablePage;
	/** Opt this scope out of the "every key must be asserted" check. */
	etc(): AssertablePage;
	/** The flash bag has `key` (dot path), optionally equal to `value`. */
	hasFlash(key: string, ...value: [unknown?]): AssertablePage;
	/** The flash bag does not have `key`. */
	missingFlash(key: string): AssertablePage;
	/** The result this scope belongs to. */
	readonly result: PageResult<never>;
}

/** Fluent assertions over a redirect / location response. */
export interface AssertableRedirect {
	/** The response status is exactly `code`. */
	status(code: number): AssertableRedirect;
	/** The redirect target. */
	location(url: string): AssertableRedirect;
	/** The signed flash cookie carries `key` (dot path), optionally equal to `value`. */
	assertFlash(key: string, ...value: [unknown?]): AssertableRedirect;
	/** The signed flash cookie does not carry `key`. */
	assertFlashMissing(key: string): AssertableRedirect;
}

// =============================================================================
// runPage
// =============================================================================

/**
 * Run a page workflow the way an Inertia client would call it.
 *
 * `x-inertia: true` is always sent (the JSON path — the HTML shell is not what
 * a page test is about), plus whichever protocol headers the options ask for.
 * Anything in `headers` wins, so a test can still send the raw thing.
 *
 * @throws when the workflow does not end in a `RespondEnvelope` — a page
 * workflow that fell through is a test bug, not a `{ ok: false }` to inspect.
 */
export async function runPage<TProps = Record<string, unknown>>(
	workflow: unknown,
	opts: RunPageOptions = {},
): Promise<PageResult<TProps>> {
	const model = await workflow;
	const component = findPageComponent(model);
	const run = await runWorkflow(model, opts.input, {
		...opts,
		headers: pageHeaders(opts, component),
		method: opts.method ?? "GET",
		state: { ...opts.state, ...opts.middleware },
	});
	return buildResult<TProps>(run, { workflow: model, opts, component });
}

// =============================================================================
// Precognition (#1011)
// =============================================================================

export interface RunPrecognitionOptions extends Omit<RunWorkflowOptions, "input"> {
	/** The submitted form payload — becomes `ctx.request.body`. */
	body?: unknown;
	/** `Precognition-Validate-Only`. Omit (or pass `[]`) to validate every field. */
	fields?: readonly string[] | string;
}

export interface PrecognitionResult {
	/** `204` when the validated fields are clean, `422` when they are not. */
	readonly status: number;
	/** The `422` body's errors, `{}` on a 204. */
	readonly errors: Record<string, unknown>;
	/** Response headers (`Precognition`, `Precognition-Success`, `Vary`). */
	readonly headers: Record<string, string>;
	/** The underlying `runWorkflow` result — assert which steps did NOT run. */
	readonly run: WorkflowRun;
}

/**
 * Drive a workflow the way Inertia's live validation does: `Precognition: true`
 * (plus `Precognition-Validate-Only` when `fields` is given) on a POST, and the
 * `204`/`422` the runner answers from the step marked `{ precognition: true }`.
 *
 * `run` is the whole `runWorkflow` result, which is the point: the assertion
 * that matters most about a dry run is the one about the steps it did NOT
 * reach — `result.run.step("create")?.executed === false`.
 *
 * @example
 * const dry = await runPrecognition(createOrder, { body: { sku: "" }, fields: ["sku"] });
 * expect(dry.status).toBe(422);
 * expect(dry.errors).toEqual({ sku: "Required." });
 * expect(dry.run.step("create")?.executed).toBe(false);
 */
export async function runPrecognition(
	workflow: unknown,
	opts: RunPrecognitionOptions = {},
): Promise<PrecognitionResult> {
	const fields = list(opts.fields);
	const run = await runWorkflow(await workflow, opts.body, {
		...opts,
		method: opts.method ?? "POST",
		headers: {
			precognition: "true",
			...(fields.length > 0 ? { "precognition-validate-only": fields.join(",") } : {}),
			...opts.headers,
		},
	});
	// Deliberately NOT routed through `runPage`: a workflow whose validation
	// step is unmarked answers with whatever its last step returned, and that is
	// the result test 9 asserts on — `runPage` would reject it for not ending in
	// a page object before the test could look.
	if (!isRespondEnvelope(run.response)) return { status: 200, errors: {}, headers: {}, run };
	const envelope = run.response;
	const errors = isObject(envelope.body) ? record<unknown>((envelope.body as { errors?: unknown }).errors) : {};
	return { status: envelope.status ?? 200, errors, headers: record<string>(envelope.headers), run };
}

// =============================================================================
// Request construction
// =============================================================================

/** Every protocol header a page visit can carry, lower-cased. */
function pageHeaders(opts: RunPageOptions, component: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "x-inertia": "true" };
	const only = list(opts.partial);
	const except = list(opts.except);
	if (only.length > 0 || except.length > 0) {
		if (!component) {
			throw new Error(
				'runPage(): a partial reload needs the page\'s component name, and this workflow declares no `page` step. Pass the component through `headers: { "x-inertia-partial-component": … }` if the page is built some other way.',
			);
		}
		headers["x-inertia-partial-component"] = component;
		if (only.length > 0) headers["x-inertia-partial-data"] = only.join(",");
		if (except.length > 0) headers["x-inertia-partial-except"] = except.join(",");
	}
	const reset = list(opts.reset);
	if (reset.length > 0) headers["x-inertia-reset"] = reset.join(",");
	const clientVersion = opts.clientVersion ?? opts.version;
	if (clientVersion !== undefined) headers["x-inertia-version"] = clientVersion;
	// Author-supplied headers win, and are lower-cased so they REPLACE rather
	// than duplicate the ones above (the runner reads them case-insensitively).
	for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
	return headers;
}

function list(value: readonly string[] | string | undefined): string[] {
	if (value === undefined) return [];
	return (typeof value === "string" ? [value] : [...value]).filter((item) => item.length > 0);
}

/**
 * The component of the first `page` step in the workflow — needed to address a
 * partial reload at the page the client is actually on.
 *
 * Structural walk over the AUTHORED model (`{ id, page: { component } }`), so it
 * works for a `definePage().render()` workflow and a JSON one alike.
 */
function findPageComponent(model: unknown): string | undefined {
	let found: string | undefined;
	const walk = (value: unknown): void => {
		if (found !== undefined || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		const obj = value as Record<string, unknown>;
		const page = obj.page as Record<string, unknown> | undefined;
		if (page && typeof page === "object" && typeof page.component === "string") {
			found = page.component;
			return;
		}
		for (const [key, nested] of Object.entries(obj)) {
			if (key !== "inputs") walk(nested);
		}
	};
	const wrapper = model as { _config?: unknown } | null;
	walk(wrapper?._config ?? model);
	return found;
}

// =============================================================================
// Response parsing
// =============================================================================

interface RunContext {
	workflow: unknown;
	opts: RunPageOptions;
	component: string | undefined;
}

interface PageObjectish {
	component?: unknown;
	props?: unknown;
	url?: unknown;
	version?: unknown;
	deferredProps?: unknown;
	rescuedProps?: unknown;
	mergeProps?: unknown;
	prependProps?: unknown;
	deepMergeProps?: unknown;
	matchPropsOn?: unknown;
	onceProps?: unknown;
	scrollProps?: unknown;
	flash?: unknown;
}

function buildResult<TProps>(run: WorkflowRun, ctx: RunContext): PageResult<TProps> {
	const envelope = finalEnvelope(run);
	const headers = record<string>(envelope.headers);
	const body = envelope.body;
	const page: PageObjectish = isObject(body) ? (body as PageObjectish) : {};
	const props = record<unknown>(page.props);
	const flash = record<unknown>(page.flash);
	if (props.errors !== undefined && flash.errors === undefined) flash.errors = props.errors;
	const deferredProps = record<string[]>(page.deferredProps);

	const result: PageResult<TProps> = {
		component: typeof page.component === "string" ? page.component : undefined,
		props: props as TProps,
		url: typeof page.url === "string" ? page.url : undefined,
		version: typeof page.version === "string" ? page.version : undefined,
		deferred: Object.values(deferredProps).flat(),
		deferredProps,
		rescued: strings(page.rescuedProps),
		mergeProps: strings(page.mergeProps),
		prependProps: strings(page.prependProps),
		deepMergeProps: strings(page.deepMergeProps),
		matchPropsOn: strings(page.matchPropsOn),
		onceProps: record<unknown>(page.onceProps),
		scrollProps: record<unknown>(page.scrollProps),
		flash,
		status: typeof envelope.status === "number" ? envelope.status : 200,
		headers,
		cookies: Array.isArray(envelope.cookies) ? envelope.cookies.map(String) : [],
		location:
			header(headers, "location") ?? header(headers, "x-inertia-location") ?? header(headers, "x-inertia-redirect"),
		body,
		run,
		assert: () => new Assertions(props, result as PageResult<never>, "props"),
		assertRedirect: (url?: string) => assertRedirect(result as PageResult<never>, ctx, url),
		reloadOnly: (keys, scope) => reload<TProps>(ctx, { partial: keys, except: undefined }, scope),
		reloadExcept: (keys, scope) => reload<TProps>(ctx, { partial: undefined, except: keys }, scope),
		loadDeferredProps: (groups, scope) => {
			const keys = list(groups).flatMap((group) => {
				const bucket = deferredProps[group];
				if (!bucket) {
					const known = Object.keys(deferredProps);
					throw new Error(
						`loadDeferredProps("${group}"): this page announced no such deferred group. Announced: ${
							known.length > 0 ? known.map((g) => `"${g}"`).join(", ") : "(none)"
						}.`,
					);
				}
				return bucket;
			});
			return reload<TProps>(ctx, { partial: keys, except: undefined }, scope);
		},
	};
	return result;
}

/** Re-run the same workflow with new partial-reload headers. */
async function reload<TProps>(
	ctx: RunContext,
	overrides: Pick<RunPageOptions, "partial" | "except">,
	scope?: PageScope,
): Promise<PageResult<TProps>> {
	const fresh = await runPage<TProps>(ctx.workflow, { ...ctx.opts, ...overrides });
	scope?.(fresh.assert() as AssertablePage);
	return fresh;
}

/**
 * The `RespondEnvelope` the run ended on.
 *
 * Normally the final step's output; a page step followed by another step still
 * has one further back, so the steps are scanned in reverse before giving up.
 */
function finalEnvelope(run: WorkflowRun): RespondEnvelope {
	if (isRespondEnvelope(run.response)) return run.response;
	for (let i = run.steps.length - 1; i >= 0; i--) {
		const step = run.steps[i];
		if (step?.executed && isRespondEnvelope(step.output)) return step.output;
	}
	const executed = run.steps.filter((step) => step.executed);
	const last = executed[executed.length - 1] ?? run.steps[run.steps.length - 1];
	const because = run.ok
		? `it returned ${preview(last?.output)}`
		: `it failed: ${run.error instanceof Error ? run.error.message : String(run.error)}`;
	throw new Error(
		`runPage(): workflow did not end in an Inertia page or redirect — the last step was "${last?.id ?? "(none)"}" and ${because}. A page workflow must end in \`definePage().render(...)\` (or an @blokjs/inertia redirect/location); use runWorkflow() for anything else.`,
	);
}

// =============================================================================
// Assertions
// =============================================================================

class Assertions implements AssertablePage {
	private readonly touched = new Set<string>();
	private exhaustive = true;

	constructor(
		private readonly target: unknown,
		readonly result: PageResult<never>,
		private readonly label: string,
	) {}

	component(name: string): this {
		if (this.result.component !== name) {
			throw new Error(`Expected page component "${name}", got ${this.result.component ?? "(no page — a redirect?)"}.`);
		}
		return this;
	}

	has(key: string, a?: number | PageScope, b?: PageScope): this {
		const scope = typeof a === "function" ? a : b;
		const count = typeof a === "number" ? a : undefined;
		const found = pathGet(this.target, key);
		this.touched.add(rootSegment(key));
		if (!found.exists) {
			throw new Error(`${this.label}: expected "${key}" to be present, but it is not. Present: ${this.keyList()}.`);
		}
		if (count !== undefined) {
			const size = sizeOf(found.value);
			if (size !== count) {
				throw new Error(
					`${this.label}: expected "${key}" to have ${count} item(s), got ${size === undefined ? preview(found.value) : size}.`,
				);
			}
		}
		if (scope) {
			const child = new Assertions(found.value, this.result, `${this.label}.${key}`);
			scope(child);
			child.finish();
		}
		return this;
	}

	where(key: string, value: unknown): this {
		const found = pathGet(this.target, key);
		this.touched.add(rootSegment(key));
		if (!found.exists) {
			throw new Error(`${this.label}: expected "${key}" to be present, but it is not. Present: ${this.keyList()}.`);
		}
		if (!isDeepStrictEqual(found.value, value)) {
			throw new Error(`${this.label}: expected "${key}" to be ${preview(value)}, got ${preview(found.value)}.`);
		}
		return this;
	}

	missing(key: string): this {
		this.touched.add(rootSegment(key));
		const found = pathGet(this.target, key);
		if (found.exists) {
			throw new Error(`${this.label}: expected "${key}" to be missing, but it is ${preview(found.value)}.`);
		}
		return this;
	}

	etc(): this {
		this.exhaustive = false;
		return this;
	}

	/** Keys present in this scope, for a failure message that says what IS there. */
	private keyList(): string {
		const keys = immediateKeys(this.target);
		return keys.length > 0 ? keys.map((key) => `"${key}"`).join(", ") : "(nothing)";
	}

	hasFlash(key: string, ...value: [unknown?]): this {
		assertFlashValue(this.result.flash, key, value, "page");
		return this;
	}

	missingFlash(key: string): this {
		assertFlashMissing(this.result.flash, key, "page");
		return this;
	}

	/**
	 * Exhaustiveness, checked when a `has(key, scope)` scope closes: every
	 * immediate key of the scoped value must have been asserted, or the scope
	 * must have ended with `.etc()`. A test that names three of five props and
	 * passes is a test that will keep passing when props two and four rot.
	 *
	 * ponytail: the ROOT chain has no closing moment (it is a chain, not a
	 * closure), so it is never checked — `.etc()` there is accepted and ignored.
	 */
	private finish(): void {
		if (!this.exhaustive) return;
		const untouched = immediateKeys(this.target).filter((key) => !this.touched.has(key));
		if (untouched.length === 0) return;
		throw new Error(
			`${this.label}: ${untouched.length} key(s) left untouched: ${untouched.map((k) => `"${k}"`).join(", ")}. Assert them with has()/where()/missing(), or end the scope with .etc().`,
		);
	}
}

function assertRedirect(result: PageResult<never>, ctx: RunContext, url?: string): AssertableRedirect {
	const isRedirect = (result.status >= 300 && result.status < 400) || result.location !== undefined;
	if (!isRedirect) {
		throw new Error(
			`Expected a redirect, got status ${result.status}${result.component ? ` and page "${result.component}"` : ""}.`,
		);
	}
	if (url !== undefined && result.location !== url) {
		throw new Error(`Expected a redirect to "${url}", got ${result.location ?? "(no Location header)"}.`);
	}
	const flash = (): Record<string, unknown> => redirectFlash(result, ctx);
	const api: AssertableRedirect = {
		status(code: number) {
			if (result.status !== code) throw new Error(`Expected status ${code}, got ${result.status}.`);
			return api;
		},
		location(target: string) {
			if (result.location !== target) {
				throw new Error(`Expected a redirect to "${target}", got ${result.location ?? "(no Location header)"}.`);
			}
			return api;
		},
		assertFlash(key: string, ...value: [unknown?]) {
			assertFlashValue(flash(), key, value, "flash cookie");
			return api;
		},
		assertFlashMissing(key: string) {
			assertFlashMissing(flash(), key, "flash cookie");
			return api;
		},
	};
	return api;
}

/** `expected` is a rest tuple so "no expected value" and `undefined` stay distinguishable. */
function assertFlashValue(bag: Record<string, unknown>, key: string, expected: [unknown?], where: string): void {
	const found = pathGet(bag, key);
	if (!found.exists) {
		const keys = Object.keys(bag);
		throw new Error(
			`Expected the ${where} flash to carry "${key}". Present: ${keys.length > 0 ? keys.map((k) => `"${k}"`).join(", ") : "(nothing)"}.`,
		);
	}
	if (expected.length > 0 && !isDeepStrictEqual(found.value, expected[0])) {
		throw new Error(`Expected flash "${key}" to be ${preview(expected[0])}, got ${preview(found.value)}.`);
	}
}

function assertFlashMissing(bag: Record<string, unknown>, key: string, where: string): void {
	const found = pathGet(bag, key);
	if (found.exists) {
		throw new Error(`Expected the ${where} flash NOT to carry "${key}", but it is ${preview(found.value)}.`);
	}
}

// =============================================================================
// Flash cookie
// =============================================================================

/** Verify + decode the flash token the redirect set, as `{ ...flash, errors }`. */
function redirectFlash(result: PageResult<never>, ctx: RunContext): Record<string, unknown> {
	const token = flashToken(result.cookies);
	if (token === undefined) return {};
	const secret = ctx.opts.flashSecret ?? process.env.BLOK_FLASH_SECRET;
	if (!secret) {
		throw new Error(
			"assertFlash(): the response carries a signed flash cookie but no secret to verify it with. Set BLOK_FLASH_SECRET, or pass `flashSecret` to runPage().",
		);
	}
	const payload = verifyFlash(token, secret);
	if (!payload) {
		throw new Error(
			`assertFlash(): the ${FLASH_COOKIE} cookie did not verify against the secret in use — tampered, or signed with a different one.`,
		);
	}
	const errors = payload.errors;
	return { ...record<unknown>(payload.flash), ...(errors !== undefined ? { errors } : {}) };
}

/** The flash cookie's VALUE out of the envelope's raw `Set-Cookie` strings. */
function flashToken(cookies: readonly string[]): string | undefined {
	for (const cookie of cookies) {
		const value = readCookie(cookie.split(";")[0], FLASH_COOKIE);
		if (value !== undefined && value.length > 0) return value;
	}
	return undefined;
}

// =============================================================================
// Small helpers
// =============================================================================

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function record<T>(value: unknown): Record<string, T> {
	return isObject(value) && !Array.isArray(value) ? ({ ...value } as Record<string, T>) : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

function header(headers: Record<string, string>, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

function rootSegment(path: string): string {
	const dot = path.indexOf(".");
	return dot === -1 ? path : path.slice(0, dot);
}

/** Dot-path read that walks arrays by index too (`orders.0.id`). */
function pathGet(source: unknown, path: string): { exists: boolean; value: unknown } {
	let cursor: unknown = source;
	for (const key of path.split(".")) {
		if (Array.isArray(cursor)) {
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return { exists: false, value: undefined };
			cursor = cursor[index];
			continue;
		}
		if (!isObject(cursor) || !(key in cursor)) return { exists: false, value: undefined };
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return { exists: true, value: cursor };
}

/** The keys a scope must account for: array indices, or an object's own keys. */
function immediateKeys(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((_, index) => String(index));
	return isObject(value) ? Object.keys(value) : [];
}

/** How many entries a value has — array length or object key count; `undefined` for a scalar. */
function sizeOf(value: unknown): number | undefined {
	if (Array.isArray(value)) return value.length;
	if (isObject(value)) return Object.keys(value).length;
	return undefined;
}

function preview(value: unknown): string {
	if (value === undefined) return "undefined";
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text.length > 120 ? `${text.slice(0, 117)}…` : text;
	} catch {
		return String(value);
	}
}
