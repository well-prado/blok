/**
 * `blokctl gen app-types` — the Inertia half (#998).
 *
 * The numbered cases map 1:1 to the tests listed in the issue. Every one of
 * them runs the REAL scanner against a real fixture project: the whole point
 * of this generator is that it executes the workflow modules, so a test that
 * stubbed the registry would prove nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectTsFiles, generateAppTypes, resolveOutPaths } from "./appTypes.js";
import {
	buildPagesSource,
	buildRoutesModuleSource,
	generatePages,
	importFailureMessage,
	zodToTs,
} from "./pagesTypes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "../../../tests/fixtures");
const inertiaApp = path.join(fixtures, "inertia-app");
const golden = path.join(inertiaApp, "golden");

const tmpDirs: string[] = [];
async function tmpDir(prefix = "blok-pages-"): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** Run the whole command against a fixture project, capturing its output. */
async function run(
	project: string,
	extra: Record<string, unknown> = {},
): Promise<{ out: string; logs: string; error: Error | null }> {
	const out = (extra.out as string | undefined) ?? (await tmpDir());
	const logs: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
	const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
	let error: Error | null = null;
	try {
		await generateAppTypes({ dir: path.join(project, "workflows"), out, ...extra });
	} catch (e) {
		error = e as Error;
	} finally {
		log.mockRestore();
		err.mockRestore();
	}
	return { out, logs: logs.join("\n"), error };
}

const read = (dir: string, file: string) => fsp.readFile(path.join(dir, file), "utf8");

afterEach(async () => {
	for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
	tmpDirs.length = 0;
});

// =============================================================================
// 1, 10, 11 — the golden files
// =============================================================================

describe("golden output", () => {
	it("1. matches the committed blok-pages.d.ts byte-for-byte", async () => {
		const { out, error } = await run(inertiaApp);
		expect(error).toBeNull();
		expect(await read(out, "blok-pages.d.ts")).toBe(await read(golden, "blok-pages.d.ts"));
	});

	it("2. emits a runtime blok-routes.ts with lowercase methods and `:param` urls", async () => {
		const { out } = await run(inertiaApp);
		const routes = await read(out, "blok-routes.ts");
		expect(routes).toBe(await read(golden, "blok-routes.ts"));
		expect(routes).toContain("registerRoutes({");
		expect(routes).toContain('"orders.show": { url: "/orders/:id", method: "get", component: "Orders/Show" }');
		// #997: Inertia's `Method` union is lowercase, never "POST".
		expect(routes).toContain('method: "post"');
		expect(routes).not.toMatch(/method: "(GET|POST)"/);
	});

	it("2b. types params for routes that have them and omits the key for routes that do not", async () => {
		const pages = await read(golden, "blok-pages.d.ts");
		expect(pages).toContain('"orders.show": { params: { id: string }; method: "get"');
		expect(pages).toContain("params: { id: string; lineId: string };");
		// `RouteArgs` makes ANY `params` type a required argument, so a paramless
		// route must omit the key entirely — `params: {}` would break `route("x")`.
		expect(pages).toContain('"orders.index": { method: "get"; path: "/orders"; component: "Orders/Index" };');
	});

	it("10. prop modes decide optionality: optional/defer optional, once/scroll/merge/always required", async () => {
		const pages = await read(golden, "blok-pages.d.ts");
		expect(pages).toContain("filters?: {"); // optional()
		expect(pages).toContain("stats?: {"); // defer()
		expect(pages).toMatch(/\bauth: \{/); // always()
		expect(pages).toMatch(/\bform: \{/); // once()
		expect(pages).toMatch(/\bevents: \{/); // scroll() / merge()
	});

	it("11. augments Inertia's own InertiaConfig", async () => {
		const pages = await read(golden, "blok-pages.d.ts");
		expect(pages).toContain('declare module "@inertiajs/core" {');
		expect(pages).toContain("interface InertiaConfig {");
		expect(pages).toContain("sharedPageProps: Record<never, never>;");
		expect(pages).toContain("flashDataType: Record<string, unknown>;");
		expect(pages).toContain("errorValueType: string;");
	});

	it("11b. --with-all-errors widens errorValueType to string[]", async () => {
		const { out } = await run(inertiaApp, { withAllErrors: true });
		expect(await read(out, "blok-pages.d.ts")).toContain("errorValueType: string[];");
	});

	it("12. a route carries `component` only when its workflow renders a page", async () => {
		const pages = await read(golden, "blok-pages.d.ts");
		expect(pages).toContain('"orders.export": { method: "get"; path: "/orders/export" };');
		expect(pages).toContain('component: "Orders/Index"');
		const routes = await read(golden, "blok-routes.ts");
		expect(routes).toContain('"orders.export": { url: "/orders/export", method: "get" },');
	});

	it("3. is deterministic — two runs produce identical bytes", async () => {
		const first = await run(inertiaApp);
		const second = await run(inertiaApp);
		expect(await read(first.out, "blok-pages.d.ts")).toBe(await read(second.out, "blok-pages.d.ts"));
		expect(await read(first.out, "blok-routes.ts")).toBe(await read(second.out, "blok-routes.ts"));
	});
});

// =============================================================================
// 4, 5, 6, 7 — behaviour
// =============================================================================

describe("project shapes", () => {
	it("4. reports a workflow that throws on import, still emits the others, and fails the run", async () => {
		const { out, logs, error } = await run(path.join(fixtures, "inertia-broken"));
		expect(error).not.toBeNull();
		// The CLI's error boundary turns this throw into `process.exitCode = 1`.
		expect(error?.message).toContain("explodes.ts");
		expect(error?.message).toContain("boom: this workflow module cannot be imported");
		expect(logs).toContain("explodes.ts");
		const pages = await read(out, "blok-pages.d.ts");
		expect(pages).toContain('"Broken/One"');
		expect(pages).toContain('"Broken/Two"');
	});

	it("5. a project without @blokjs/inertia is skipped silently, with one info line", async () => {
		const { out, logs, error } = await run(path.join(fixtures, "plain-app"));
		expect(error).toBeNull();
		expect(existsSync(path.join(out, "blok-pages.d.ts"))).toBe(false);
		expect(existsSync(path.join(out, "blok-routes.ts"))).toBe(false);
		expect(logs).toContain("No @blokjs/inertia in this project");
		// …and the @blokjs/client half still ran.
		expect(existsSync(path.join(out, "blok-app.d.ts"))).toBe(true);
	});

	it("6. --out <dir> writes there, and the generated imports stay package-absolute", async () => {
		const out = await tmpDir("blok-pages-out-");
		const { error } = await run(inertiaApp, { out });
		expect(error).toBeNull();
		expect(existsSync(path.join(out, "blok-pages.d.ts"))).toBe(true);
		const pages = await read(out, "blok-pages.d.ts");
		expect(pages).toContain('import "@blokjs/inertia-client";');
		expect(pages).not.toContain("../");
		expect(await read(out, "blok-routes.ts")).toContain('from "@blokjs/inertia-client"');
	});

	it("6b. --out still accepts a FILE path (the blok-app.d.ts spelling it always had)", () => {
		expect(resolveOutPaths("/proj", "web/blok-app.d.ts")).toEqual({
			outFile: "/proj/web/blok-app.d.ts",
			outDir: "/proj/web",
		});
		expect(resolveOutPaths("/proj", "../spa/src")).toEqual({
			outFile: "/spa/src/blok-app.d.ts",
			outDir: "/spa/src",
		});
	});

	it("--pages-only writes the Inertia files and no blok-app.d.ts", async () => {
		const { out } = await run(inertiaApp, { pagesOnly: true });
		expect(existsSync(path.join(out, "blok-pages.d.ts"))).toBe(true);
		expect(existsSync(path.join(out, "blok-app.d.ts"))).toBe(false);
	});

	it("7. a runtimeNode stub with no Zod schema becomes `unknown` and is named in a warning", async () => {
		const { out, logs } = await run(inertiaApp);
		expect(await read(out, "blok-pages.d.ts")).toContain("legacy: unknown;");
		expect(logs).toContain("no Zod output schema");
		expect(logs).toContain("fixture-legacy-stats");
	});
});

// =============================================================================
// 8 — the generated types actually compile
// =============================================================================

describe("generated types compile", () => {
	/** The workspace's own tsc — never a network-resolved one. */
	function tscBin(): string {
		let dir = path.join(here, "../../..");
		for (;;) {
			const candidate = path.join(dir, "node_modules", ".bin", "tsc");
			if (existsSync(candidate)) return candidate;
			const parent = path.dirname(dir);
			if (parent === dir) throw new Error("no local tsc found");
			dir = parent;
		}
	}

	it("8. a React page using PageProps<'Orders/Index'> compiles; `props.nope` does not", () => {
		// Every misuse in tests/fixtures/spa/negative.ts is `@ts-expect-error`,
		// so the project compiles clean IFF each one really is an error —
		// `props.nope` included.
		const result = spawnSync(tscBin(), ["--noEmit", "-p", path.join(fixtures, "spa")], { encoding: "utf8" });
		expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toBe("");
		expect(result.status).toBe(0);
	}, 120_000);
});

// =============================================================================
// 9 — watch
// =============================================================================

describe("--watch", () => {
	// The temp project lives INSIDE the repo: the workflow modules import
	// `@blokjs/core` / `@blokjs/inertia`, which only resolve from here.
	let project = "";

	beforeEach(async () => {
		project = path.join(fixtures, `tmp-watch-${process.pid}`);
		await fsp.mkdir(path.join(project, "workflows"), { recursive: true });
		await fsp.writeFile(
			path.join(project, "package.json"),
			JSON.stringify({ name: "blok-fixture-watch", private: true, dependencies: { "@blokjs/inertia": "*" } }),
		);
		await fsp.writeFile(path.join(project, "workflows", "one.ts"), workflowSource("One", "/one"));
	});

	afterEach(async () => {
		await fsp.rm(project, { recursive: true, force: true });
	});

	function workflowSource(name: string, url: string): string {
		return `import { defineNode, http, workflow } from "@blokjs/core";
import { definePage } from "@blokjs/inertia";
import { z } from "zod";

const node = defineNode({
	name: "watch-${name.toLowerCase()}",
	description: "prop",
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	async execute() { return { ok: true }; },
});

export const Page = definePage("Watch/${name}", { data: node });

export default workflow("watch.${name.toLowerCase()}", { version: "1.0.0", trigger: http.get("${url}") }, (req) => {
	Page.render(req, "page", "${url}", {});
});
`;
	}

	/** Poll the generated file for at most 2 s, exactly as the issue specifies. */
	async function poll(file: string, predicate: (content: string) => boolean): Promise<string> {
		const deadline = Date.now() + 2_000;
		let content = "";
		while (Date.now() < deadline) {
			content = await fsp.readFile(file, "utf8").catch(() => "");
			if (predicate(content)) return content;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`timed out waiting for ${file}; last content:\n${content}`);
	}

	it("9. regenerates when a workflow file is added, and again when it is removed", async () => {
		const controller = new AbortController();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const loop = generateAppTypes({
			dir: path.join(project, "workflows"),
			out: project,
			watch: true,
			signal: controller.signal,
		});
		const pagesFile = path.join(project, "blok-pages.d.ts");
		try {
			await poll(pagesFile, (c) => c.includes('"Watch/One"'));

			await fsp.writeFile(path.join(project, "workflows", "two.ts"), workflowSource("Two", "/two"));
			const withTwo = await poll(pagesFile, (c) => c.includes('"Watch/Two"'));
			expect(withTwo).toContain('"Watch/One"');

			await fsp.rm(path.join(project, "workflows", "two.ts"));
			await poll(pagesFile, (c) => !c.includes('"Watch/Two"'));
		} finally {
			controller.abort();
			await loop;
			log.mockRestore();
		}
	}, 30_000);
});

// =============================================================================
// The Zod → TS converter
// =============================================================================

describe("zodToTs", () => {
	it("renders the shapes page props are actually made of", () => {
		expect(zodToTs(z.string())).toBe("string");
		expect(zodToTs(z.number().nullable())).toBe("number | null");
		expect(zodToTs(z.array(z.boolean()))).toBe("Array<boolean>");
		expect(zodToTs(z.union([z.literal("a"), z.literal(1)]))).toBe('"a" | 1');
		expect(zodToTs(z.enum(["a", "b"]))).toBe('"a" | "b"');
		expect(zodToTs(z.record(z.string(), z.number()))).toBe("Record<string, number>");
		expect(zodToTs(z.tuple([z.string(), z.number()]))).toBe("[string, number]");
		expect(zodToTs(z.object({}))).toBe("Record<string, never>");
		// Transparent wrappers keep the shape of what they wrap.
		expect(zodToTs(z.string().default("x"))).toBe("string");
		expect(zodToTs(z.number().brand<"cents">())).toBe("number");
		// Dates cross the wire as JSON.
		expect(zodToTs(z.date())).toBe("string");
	});

	it("explains the one import failure whose raw message hides the fix", () => {
		const raw = new Error('Unknown file extension ".ts" for /p/wf.ts');
		expect(importFailureMessage(raw)).toContain("Run blokctl under Bun, or Node >= 22.18");
		expect(importFailureMessage(new Error("boom"))).toBe("boom");
	});

	it("makes `.optional()` an optional KEY, not a `| undefined` value", () => {
		expect(zodToTs(z.object({ a: z.string().optional() }), "")).toBe("{\n\ta?: string;\n}");
	});

	it("falls back to `unknown` and reports what it could not model", () => {
		const unsupported: string[] = [];
		expect(zodToTs(z.map(z.string(), z.number()), "", unsupported)).toBe("unknown");
		expect(unsupported).toEqual(["ZodMap"]);
	});
});

// =============================================================================
// Pure emitters
// =============================================================================

describe("emitters", () => {
	const empty = { pages: [], routes: [], failures: [], schemaless: [], unsupported: [] };

	it("emit nothing at all when a project has no pages and no routes", () => {
		expect(buildPagesSource(empty)).toBeNull();
		expect(buildRoutesModuleSource([])).toBeNull();
	});

	it("emit a Routes block on its own when a project has routes but no pages", () => {
		const source = buildPagesSource({
			...empty,
			routes: [{ name: "health", method: "get", url: "/health", params: [] }],
		});
		expect(source).toContain("interface Routes {");
		expect(source).not.toContain("interface Pages {");
	});

	it("carry a stable order regardless of scan order", async () => {
		const files = await collectTsFiles(path.join(inertiaApp, "workflows"));
		const forward = await generatePages({
			dir: path.join(inertiaApp, "workflows"),
			outDir: await tmpDir(),
			files,
			log: () => {},
		});
		const backward = await generatePages({
			dir: path.join(inertiaApp, "workflows"),
			outDir: await tmpDir(),
			files: [...files].reverse(),
			log: () => {},
		});
		const [a, b] = await Promise.all([
			fsp.readFile(path.join(path.dirname(forward.written[0] as string), "blok-pages.d.ts"), "utf8"),
			fsp.readFile(path.join(path.dirname(backward.written[0] as string), "blok-pages.d.ts"), "utf8"),
		]);
		expect(a).toBe(b);
	});
});
