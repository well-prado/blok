import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Plugin, type ViteDevServer, build, createServer as createViteServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSET_VERSION_FILE, PAGES_FILE, SSR_URL_FILE, VITE_DESCRIPTOR_FILE, blokInertia } from "../src/vite.js";

const APP_ENTRY = "document.title = `${import.meta.env.BLOK_ASSET_VERSION} v1`;\n";

const INDEX_HTML = [
	"<!doctype html>",
	'<html lang="en">',
	"<body>",
	'<div id="app"></div>',
	'<script type="module" src="/src/app.js"></script>',
	"</body>",
	"</html>",
	"",
].join("\n");

const SSR_ENTRY = 'export default (page) => ({ head: [], body: `<div data-component="${page.component}"></div>` });\n';

const roots: string[] = [];

function write(root: string, relative: string, content: string): void {
	const file = join(root, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/** A minimal Vite SPA: one entry that reads the asset version, and two pages. */
function makeProject(extra: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "blok-inertia-"));
	roots.push(root);
	write(root, "index.html", INDEX_HTML);
	write(root, "src/app.js", APP_ENTRY);
	write(root, "src/Pages/Dashboard.jsx", "export default function Dashboard() {}\n");
	write(root, "src/Pages/Orders/Index.jsx", "export default function Index() {}\n");
	for (const [relative, content] of Object.entries(extra)) write(root, relative, content);
	return root;
}

function sha256(input: Buffer | string): string {
	return createHash("sha256").update(input).digest("hex");
}

function read(root: string, ...parts: string[]): string {
	return readFileSync(join(root, "dist", ...parts), "utf8");
}

function bundledJs(root: string): string {
	const manifest = JSON.parse(read(root, ".vite", "manifest.json")) as Record<string, { file: string }>;
	return Object.values(manifest)
		.filter((chunk) => chunk.file.endsWith(".js"))
		.map((chunk) => read(root, chunk.file))
		.join("\n");
}

/** `ssr: false` keeps `src/app.js` from being auto-detected as an SSR entry. */
async function buildProject(root: string): Promise<void> {
	await build({ root, logLevel: "silent", plugins: [blokInertia({ ssr: false, proxy: false })] });
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

interface Stub {
	server: Server;
	url: string;
	requests: { url: string; headers: IncomingMessage["headers"] }[];
}

/** Stands in for a live Blok server on BLOK_URL. */
async function startStubBlok(): Promise<Stub> {
	const requests: Stub["requests"] = [];
	const server = createHttpServer((req, res) => {
		requests.push({ url: req.url ?? "", headers: req.headers });
		res.statusCode = 200;
		res.setHeader("content-type", "text/plain");
		res.end("from-blok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return { server, url: `http://127.0.0.1:${port}`, requests };
}

let dev: ViteDevServer | null = null;
let stub: Stub | null = null;

beforeEach(() => {
	dev = null;
	stub = null;
});

afterEach(async () => {
	await dev?.close();
	if (stub !== null) await new Promise<void>((resolve) => stub?.server.close(() => resolve()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("blokInertia() build", () => {
	it("writes an asset-version file that is the sha256 of the Vite manifest", async () => {
		const root = makeProject();
		await buildProject(root);

		const version = read(root, ASSET_VERSION_FILE);
		expect(version).toBe(sha256(readFileSync(join(root, "dist", ".vite", "manifest.json"))));
		expect(version).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is stable across rebuilds and changes when a source line changes", async () => {
		const root = makeProject();
		await buildProject(root);
		const first = read(root, ASSET_VERSION_FILE);

		await buildProject(root);
		expect(read(root, ASSET_VERSION_FILE)).toBe(first);

		write(root, "src/app.js", APP_ENTRY.replace("v1", "v2"));
		await buildProject(root);
		expect(read(root, ASSET_VERSION_FILE)).not.toBe(first);
	});

	it("inlines import.meta.env.BLOK_ASSET_VERSION into the bundle", async () => {
		const root = makeProject();
		await buildProject(root);

		const code = bundledJs(root);
		expect(code).not.toContain("import.meta.env.BLOK_ASSET_VERSION");
		expect(code).not.toContain("__BLOK_ASSET_VERSION__");
		expect(code).toContain(read(root, ASSET_VERSION_FILE));
	});

	it("writes the page manifest ensurePagesExist reads", async () => {
		const root = makeProject();
		await buildProject(root);

		expect(JSON.parse(read(root, PAGES_FILE))).toEqual({
			root: "src/Pages",
			pages: ["Dashboard", "Orders/Index"],
		});
	});
});

describe("blokInertia() dev server", () => {
	it("proxies app requests to BLOK_URL with X-Inertia-Version: dev, and leaves assets to Vite", async () => {
		stub = await startStubBlok();
		const root = makeProject();
		const port = await freePort();
		dev = await createViteServer({
			root,
			logLevel: "silent",
			server: { host: "127.0.0.1", port, strictPort: true },
			plugins: [blokInertia({ ssr: false, proxy: { target: stub.url } })],
		});
		await dev.listen();

		const proxied = await fetch(`http://127.0.0.1:${port}/orders`);
		expect(await proxied.text()).toBe("from-blok");
		expect(stub.requests.map((r) => r.url)).toEqual(["/orders"]);
		expect(stub.requests[0]?.headers["x-inertia-version"]).toBe("dev");

		await fetch(`http://127.0.0.1:${port}/assets/app.js`).catch(() => undefined);
		expect(stub.requests.map((r) => r.url)).toEqual(["/orders"]);
	});

	it("exposes the Inertia SSR dev endpoint and writes BLOK_SSR_URL", async () => {
		const root = makeProject({ "src/ssr.js": SSR_ENTRY });
		const port = await freePort();
		dev = await createViteServer({
			root,
			logLevel: "silent",
			server: { host: "127.0.0.1", port, strictPort: true },
			plugins: [blokInertia({ ssr: { entry: "src/ssr.js" }, proxy: false })],
		});
		await dev.listen();

		const ssrUrl = read(root, SSR_URL_FILE);
		expect(ssrUrl).toBe(`http://localhost:${port}/__inertia_ssr`);
		expect(read(root, ASSET_VERSION_FILE)).toBe("dev");

		// The endpoint answers `null` until the SSR module graph is warm.
		let rendered: { body?: string } | null = null;
		for (let attempt = 0; attempt < 20 && rendered === null; attempt++) {
			const response = await fetch(`http://127.0.0.1:${port}/__inertia_ssr`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ component: "Orders/Index", props: {}, url: "/orders", version: "1" }),
			});
			expect(response.status).toBe(200);
			rendered = (await response.json()) as { body?: string } | null;
		}
		expect(rendered?.body).toContain('data-component="Orders/Index"');
	});
});

// =============================================================================
// #1051 — the asset descriptor the Blok shell is built from
// =============================================================================

/** Stands in for `@vitejs/plugin-react` without pulling it in: only the name is read. */
const FAKE_REACT: Plugin = { name: "vite:react-babel" };

interface Descriptor {
	mode: string;
	devUrl?: string;
	entry: string;
	css?: string[];
	imports?: string[];
	framework: string | null;
}

function descriptor(root: string): Descriptor {
	return JSON.parse(read(root, VITE_DESCRIPTOR_FILE)) as Descriptor;
}

describe("blokInertia() asset descriptor (#1051)", () => {
	it("describes the built entry, its css and its static imports", async () => {
		const root = makeProject({
			"src/app.css": "body { color: red }\n",
			"src/app.js": `${APP_ENTRY}import "./app.css";\nimport("./lazy.js");\n`,
			"src/lazy.js": "export const lazy = 1;\n",
		});
		await buildProject(root);

		const file = descriptor(root);
		const manifest = JSON.parse(read(root, ".vite", "manifest.json")) as Record<string, { file: string }>;

		expect(file.mode).toBe("build");
		expect(file.framework).toBeNull();
		// The entry is the manifest's JS entry chunk, and it exists on disk.
		// (Vite keys an HTML input by the HTML file; `file` is the hashed JS.)
		expect(file.entry).toBe(manifest["index.html"]?.file);
		expect(file.entry).toMatch(/^assets\/.+\.js$/);
		expect(existsSync(join(root, "dist", file.entry))).toBe(true);
		// The stylesheet the entry imports is listed, and also exists.
		expect(file.css).toHaveLength(1);
		expect(file.css?.[0]).toMatch(/^assets\/.+\.css$/);
		expect(existsSync(join(root, "dist", file.css?.[0] ?? ""))).toBe(true);
		// A dynamic import is NOT a static import: preloading it would defeat it.
		expect(file.imports).toEqual([]);
	});

	it("records the framework so the shell can emit the React refresh preamble", async () => {
		const root = makeProject();
		await build({ root, logLevel: "silent", plugins: [blokInertia({ ssr: false, proxy: false }), FAKE_REACT] });

		expect(descriptor(root).framework).toBe("react");
	});

	it("points at the live dev server, and removes the descriptor when it closes", async () => {
		const root = makeProject();
		const port = await freePort();
		dev = await createViteServer({
			root,
			logLevel: "silent",
			server: { host: "127.0.0.1", port, strictPort: true },
			plugins: [blokInertia({ ssr: false, proxy: false }), FAKE_REACT],
		});
		await dev.listen();

		expect(descriptor(root)).toEqual({
			mode: "dev",
			devUrl: `http://localhost:${port}`,
			// The module script of index.html, exactly as Vite serves it.
			entry: "src/app.js",
			framework: "react",
		});

		await dev.close();
		dev = null;
		expect(existsSync(join(root, "dist", VITE_DESCRIPTOR_FILE))).toBe(false);
	});

	it("prefers an explicit rollupOptions.input over index.html", async () => {
		const root = makeProject({ "src/other.js": "export const other = 1;\n" });
		await build({
			root,
			logLevel: "silent",
			build: { rollupOptions: { input: join(root, "src/other.js") } },
			plugins: [blokInertia({ ssr: false, proxy: false })],
		});

		const manifest = JSON.parse(read(root, ".vite", "manifest.json")) as Record<string, { file: string }>;
		expect(descriptor(root).entry).toBe(manifest["src/other.js"]?.file);
	});
});
