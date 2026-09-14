/**
 * Issue #1051, test 5 — the example, built and served for real.
 *
 * Every other test in this folder runs the engine in-process. This one runs
 * `vite build`, starts the actual Blok server, and asks it for `/` over HTTP,
 * because the bug it guards could not be seen from inside the engine: the page
 * object was always correct and the HTML around it loaded no JavaScript.
 *
 * It fails if the example cannot BOOT at all, which is the other half of the
 * same promise — a README command nobody can run is not an example.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "client", "dist");

let port = 0;
let server: ReturnType<typeof spawn> | null = null;
let output = "";

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const found = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(found));
		});
	});
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: "pipe" });
		let log = "";
		child.stdout?.on("data", (chunk) => {
			log += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			log += String(chunk);
		});
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed:\n${log}`))));
	});
}

/** Poll until the server answers, so the assertions never race the boot. */
async function waitForBoot(url: string): Promise<void> {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			await fetch(url);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`the example never started on ${url}. Server output:\n${output}`);
}

beforeAll(async () => {
	// The client build writes `.blok-vite.json`, which is what the shell reads.
	await run("bun", ["run", "build"]);
	port = await freePort();
	server = spawn("bun", ["run", "src/index.ts"], {
		cwd: root,
		env: {
			...process.env,
			PORT: String(port),
			BLOK_FLASH_SECRET: "test-secret",
			BLOK_STATIC_DIR: "client/dist",
			// The page's one Python prop is `defer(..., { rescue: true })`, so the
			// sidecar is not needed to render; keep the runtime worker out too.
			BLOK_SKIP_JS_WORKER: "1",
		},
		stdio: "pipe",
	});
	server.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	server.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	await waitForBoot(`http://127.0.0.1:${port}/`);
}, 180_000);

afterAll(() => {
	server?.kill("SIGKILL");
});

describe("the built example serves a page that can actually boot", () => {
	it("answers / with the Inertia shell, not the Blok welcome page", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html).not.toContain("Welcome to blok");
		expect(html).toContain('<div id="app">');
	});

	it("loads the client bundle from a file that exists in client/dist", async () => {
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		const src = /<script type="module" src="([^"]+)"><\/script>/.exec(html)?.[1];

		expect(src).toMatch(/^\/assets\/.+\.js$/);
		expect(existsSync(join(dist, (src as string).slice(1)))).toBe(true);

		// And the server really serves it — a tag pointing at a 404 is the bug.
		const asset = await fetch(`http://127.0.0.1:${port}${src}`);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toContain("javascript");
	});

	it("links the stylesheet the same way", async () => {
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		const href = /<link rel="stylesheet" href="([^"]+)" \/>/.exec(html)?.[1];

		expect(href).toMatch(/^\/assets\/.+\.css$/);
		expect((await fetch(`http://127.0.0.1:${port}${href}`)).status).toBe(200);
	});

	it("still carries the page object the client boots from", async () => {
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		const json = /<script type="application\/json" data-page="app">(.*?)<\/script>/s.exec(html)?.[1];
		const page = JSON.parse((json as string).replace(/\\\//g, "/")) as {
			component: string;
			props: Record<string, unknown>;
		};

		expect(page.component).toBe("Dashboard");
		expect(page.props.auth).toEqual({ id: "u-1", email: "ada@example.com" });
	});

	it("answers an Inertia visit with JSON instead of the shell", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			headers: { "X-Inertia": "true", "X-Inertia-Version": "" },
		});
		const page = (await response.json()) as { component: string };

		expect(response.headers.get("x-inertia")).toBe("true");
		expect(page.component).toBe("Dashboard");
	});

	it("routes the second page too, so the Dashboard's link is not dead", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/orders/new`, {
			headers: { "X-Inertia": "true", "X-Inertia-Version": "" },
		});
		const page = (await response.json()) as { component: string };

		expect(response.status).toBe(200);
		expect(page.component).toBe("Orders/Create");
	});

	/**
	 * The server half of a nested page is useless if the client cannot load it.
	 * A hand-written `import(`./pages/${name}.tsx`)` resolver builds fine and
	 * then throws `Unknown variable dynamic import` at runtime, because Vite
	 * resolves a template-literal dynamic import only ONE directory deep — so
	 * the guard has to be that every page on disk is a chunk in the build.
	 */
	it("builds a chunk for every page, nested ones included", () => {
		const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8")) as Record<
			string,
			{ file: string }
		>;

		for (const page of ["src/pages/Dashboard.tsx", "src/pages/Orders/Create.tsx", "src/pages/Errors/Error.tsx"]) {
			expect(Object.keys(manifest)).toContain(page);
			expect(existsSync(join(dist, manifest[page].file))).toBe(true);
		}
	});
});
