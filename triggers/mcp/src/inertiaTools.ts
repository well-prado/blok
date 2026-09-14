/**
 * Built-in MCP tools for the Inertia page registry (#1019).
 *
 * An agent working on a Blok SPA needs three facts it currently has to read
 * source for: which pages exist, what each page sends the client, and which
 * URL renders which page. All three are already in memory — `definePage()`
 * records them in `getPageRegistry()`, and the workflow registry holds the
 * routes — so exposing them is a read, never a run.
 *
 * These are NOT workflows: they take no step, touch no node, and cannot write.
 * They are appended to every MCP server this trigger serves, so an app that
 * already exposes workflows over MCP gains page introspection with no wiring.
 *
 * `@blokjs/inertia` is OPTIONAL and appears in no manifest — the non-literal
 * specifier plus try/catch is the same shape `HttpTrigger` uses for
 * `renderErrorPage` (and `src/Nodes.ts` for `@blokjs/browser`), so a project
 * without the adapter behaves exactly as before.
 *
 * DEV-ONLY BY DEFAULT: a page registry is a map of the app's internals. It is
 * served when `NODE_ENV !== "production"`, and in production only when
 * `BLOK_INERTIA_MCP` is explicitly turned on.
 */

import { WorkflowRegistry } from "@blokjs/runner";
import { zodToJsonSchema } from "zod-to-json-schema";

const INERTIA_PKG = "@blokjs/inertia";

/** A JSON-Schema-ish object. Deliberately loose — it is serialized, not consumed here. */
type JsonSchema = Record<string, unknown>;

/** One prop, as `definePage()` recorded it. Mirrors `PageRegistryProp` structurally. */
interface RegistryProp {
	mode?: string;
	group?: string;
	rescue?: boolean;
	merge?: unknown;
	once?: unknown;
	scroll?: unknown;
	outputSchema?: unknown;
	source?: { file: string; line: number };
}

interface RegistryEntry {
	component: string;
	props: Record<string, RegistryProp>;
	source?: { file: string; line: number };
}

/** The slice of `@blokjs/inertia` these tools read. */
interface InertiaModule {
	getPageRegistry?: () => ReadonlyMap<string, RegistryEntry>;
	sharedKeys?: () => string[];
}

/** A read-only introspection tool, dispatched in-process instead of through the runner. */
export interface InertiaMcpTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; [key: string]: unknown };
	annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
	run(args: Record<string, unknown>): unknown;
}

/** One HTTP route, and the page component it renders when it renders one. */
export interface InertiaRoute {
	workflow: string;
	method: string;
	path: string;
	component?: string;
}

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

/**
 * Are the page tools served?
 *
 * Unset `BLOK_INERTIA_MCP` means "development only"; an explicit value wins in
 * both directions, so production can opt in and a dev box can opt out.
 */
export function inertiaToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const flag = (env.BLOK_INERTIA_MCP ?? "").trim().toLowerCase();
	if (TRUTHY.has(flag)) return true;
	if (FALSY.has(flag)) return false;
	return env.NODE_ENV !== "production";
}

/** Lazily-loaded adapter module. `null` once we know it is not installed. */
let inertiaModule: InertiaModule | null | undefined;

async function loadInertia(): Promise<InertiaModule | null> {
	if (inertiaModule !== undefined) return inertiaModule;
	try {
		const mod = (await import(INERTIA_PKG)) as InertiaModule;
		inertiaModule = typeof mod.getPageRegistry === "function" ? mod : null;
	} catch {
		inertiaModule = null;
	}
	return inertiaModule;
}

/** Test seam — drop the cached module so a suite can re-probe. */
export function _resetInertiaModule(): void {
	inertiaModule = undefined;
}

/** Modes whose prop may be absent from the page object on any given visit. */
const LAZY_MODES = new Set(["optional", "defer"]);

function jsonSchemaOf(schema: unknown): JsonSchema | undefined {
	if (!schema || typeof schema !== "object" || !("_def" in schema)) return undefined;
	try {
		// biome-ignore lint/suspicious/noExplicitAny: zod schema is opaque at this boundary
		const json = zodToJsonSchema(schema as any, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema;
		// biome-ignore lint/performance/noDelete: strip JSON-Schema meta the MCP client doesn't need
		delete json.$schema;
		return json;
	} catch {
		return undefined;
	}
}

/** One prop's metadata, without its schema — what `inertia.pages.list` returns. */
function propSummary(key: string, prop: RegistryProp): Record<string, unknown> {
	return {
		key,
		mode: prop.mode ?? "regular",
		...(prop.group !== undefined ? { group: prop.group } : {}),
		...(prop.rescue !== undefined ? { rescue: prop.rescue } : {}),
		...(prop.merge !== undefined ? { merge: prop.merge } : {}),
		...(prop.once !== undefined ? { once: prop.once } : {}),
		...(prop.scroll !== undefined ? { scroll: true } : {}),
		/** `optional` and `defer` props are absent unless the visit asked for them. */
		lazy: LAZY_MODES.has(prop.mode ?? "regular"),
		hasSchema: jsonSchemaOf(prop.outputSchema) !== undefined,
		...(prop.source ? { source: `${prop.source.file}:${prop.source.line}` } : {}),
	};
}

/**
 * The page's props as ONE JSON Schema — the shape the client receives.
 *
 * A prop with no Zod output schema (a `runtimeNode()` stub) is declared as `{}`
 * rather than omitted: the key exists on the wire, and its absence from the
 * schema would read as "this page does not send it".
 */
function pageSchema(entry: RegistryEntry): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	for (const [key, prop] of Object.entries(entry.props)) {
		properties[key] = jsonSchemaOf(prop.outputSchema) ?? {};
		if (!LAZY_MODES.has(prop.mode ?? "regular")) required.push(key);
	}
	// Always present, whatever the page declares (#1011).
	properties.errors = { type: "object", additionalProperties: true };
	required.push("errors");
	return { type: "object", properties, required, additionalProperties: true };
}

/**
 * Every HTTP route in the workflow registry, with the page component it renders.
 *
 * Read off the BUILT workflow config, the same way `blokctl gen app-types`
 * does, so there is no second parser of the authoring surface.
 */
export function listInertiaRoutes(): InertiaRoute[] {
	const routes: InertiaRoute[] = [];
	for (const entry of WorkflowRegistry.getInstance().list()) {
		const config = ((entry.workflow as { _config?: unknown })?._config ?? entry.workflow) as {
			trigger?: { http?: { method?: string; path?: string } };
			steps?: unknown;
		};
		const http = config.trigger?.http;
		if (!http || typeof http.path !== "string") continue;
		const component = firstPageComponent(config.steps);
		routes.push({
			workflow: entry.name,
			method: (http.method ?? "GET").toUpperCase(),
			path: http.path,
			...(component !== undefined ? { component } : {}),
		});
	}
	return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** The component of the first `page` control step (or `@blokjs/inertia` step) in a step tree. */
function firstPageComponent(node: unknown): string | undefined {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = firstPageComponent(item);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (node === null || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	const pageStep = record.page as { component?: unknown } | undefined;
	if (pageStep && typeof pageStep.component === "string") return pageStep.component;
	// `inertia.page()` emits ONE serializer step instead of a `page` control step.
	const inputs = record.inputs as { component?: unknown } | undefined;
	if (record.use === INERTIA_PKG && inputs && typeof inputs.component === "string") return inputs.component;
	for (const value of Object.values(record)) {
		const found = firstPageComponent(value);
		if (found !== undefined) return found;
	}
	return undefined;
}

function registryEntries(inertia: InertiaModule): RegistryEntry[] {
	const registry = inertia.getPageRegistry?.() ?? new Map<string, RegistryEntry>();
	return [...registry.values()].sort((a, b) => a.component.localeCompare(b.component));
}

/**
 * The three page tools, or `[]` when the adapter is absent or the tools are
 * gated off.
 *
 * `routes` is injectable so a test can pin the route table; production reads
 * the live workflow registry.
 */
export async function inertiaMcpTools(
	options: {
		env?: NodeJS.ProcessEnv;
		routes?: () => InertiaRoute[];
	} = {},
): Promise<InertiaMcpTool[]> {
	if (!inertiaToolsEnabled(options.env)) return [];
	const inertia = await loadInertia();
	if (!inertia) return [];
	const routes = options.routes ?? listInertiaRoutes;

	return [
		{
			name: "inertia.pages.list",
			description:
				"List every Inertia page this Blok app declares with definePage(): component name, each prop's resolution mode (regular/always/optional/defer/merge/once/scroll), and where it was declared. Read-only.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			annotations: READ_ONLY,
			run: () => ({
				pages: registryEntries(inertia).map((entry) => ({
					component: entry.component,
					...(entry.source ? { source: `${entry.source.file}:${entry.source.line}` } : {}),
					props: Object.entries(entry.props).map(([key, prop]) => propSummary(key, prop)),
				})),
				sharedKeys: inertia.sharedKeys?.() ?? [],
			}),
		},
		{
			name: "inertia.page.get",
			description:
				"Describe ONE Inertia page: every prop's mode plus the page's props as a JSON Schema, derived from each prop node's Zod output schema. This is what the page sends the client. Read-only.",
			inputSchema: {
				type: "object",
				properties: { component: { type: "string", description: 'Component name, e.g. "Orders/Index".' } },
				required: ["component"],
				additionalProperties: false,
			},
			annotations: READ_ONLY,
			run: (args) => {
				const component = typeof args.component === "string" ? args.component : "";
				const entries = registryEntries(inertia);
				const entry = entries.find((candidate) => candidate.component === component);
				if (!entry) {
					throw new Error(
						`Unknown page component "${component}". Fix: call inertia.pages.list — this app declares ${entries.map((e) => e.component).join(", ") || "no pages"}.`,
					);
				}
				return {
					component: entry.component,
					...(entry.source ? { source: `${entry.source.file}:${entry.source.line}` } : {}),
					props: Object.fromEntries(Object.entries(entry.props).map(([key, prop]) => [key, propSummary(key, prop)])),
					schema: pageSchema(entry),
				};
			},
		},
		{
			name: "inertia.routes.list",
			description:
				"List every HTTP route this Blok app serves, with the Inertia page component it renders when it renders one. Read-only.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			annotations: READ_ONLY,
			run: () => ({ routes: routes() }),
		},
	];
}
