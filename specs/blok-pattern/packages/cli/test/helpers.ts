// Every test gets its own project in the system's temp folder, and runs the built command the way a user would.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const packages = join(import.meta.dirname, "..", "..");
export const CLI = join(packages, "cli", "dist", "cli.js");
// The command is a Node script. Its full path, so a test can take everything else off the PATH.
export const NODE = Bun.which("node") ?? "node";

const made: string[] = [];
/** A fresh folder. It is removed when the test file is done. */
export function folder(): string {
	// The real path: on macOS the temp folder is a link, and the commands print real paths.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "blok-cli-")));
	made.push(dir);
	return dir;
}
export function cleanUp() {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Stands in for `npm install`: links this repo's packages, and the libraries a project uses, into `dir`.
 * `more` names the other libraries a test needs, such as "hono" or "express".
 */
export function install(dir: string, more: string[] = []) {
	const from = join(packages, "kernel", "node_modules");
	const links: Record<string, string> = {
		"@blokjs/kernel": join(packages, "kernel"),
		blokctl: join(packages, "cli"),
		zod: realpathSync(join(from, "zod")),
		fastify: realpathSync(join(from, "fastify")),
		...Object.fromEntries(more.map((name) => [name, realpathSync(join(from, name))])),
	};
	for (const [name, target] of Object.entries(links)) {
		const link = join(dir, "node_modules", name);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(target, link, "dir");
	}
}

/** Adds the TypeScript compiler and Node's types, as `npm install` would for a project made by `init`. */
export function installTypeScript(dir: string) {
	const root = join(packages, "..", "node_modules");
	for (const name of ["typescript", "@types/node", "undici-types"]) {
		const link = join(dir, "node_modules", name);
		mkdirSync(dirname(link), { recursive: true });
		if (existsSync(join(root, name))) symlinkSync(realpathSync(join(root, name)), link, "dir");
	}
	mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
	symlinkSync(join(dir, "node_modules", "typescript", "bin", "tsc"), join(dir, "node_modules", ".bin", "tsc"));
}

export function write(dir: string, file: string, content: string) {
	mkdirSync(dirname(join(dir, file)), { recursive: true });
	writeFileSync(join(dir, file), content);
}

/** Runs `blokctl <args>` in `cwd`, in its own process, as the installed command would. */
export function blokctl(cwd: string, args: string[], env: Record<string, string> = {}) {
	// Without the mark `bun run` leaves on its children, so the command behaves the same however the tests were started.
	const { npm_config_user_agent: _launcher, ...clean } = process.env;
	const run = spawnSync(NODE, [CLI, ...args], { cwd, encoding: "utf8", env: { ...clean, ...env } });
	return { exit: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

/** A project made by `blokctl init <name>`, with its dependencies in place. */
export function project(name = "shop", options: { server?: string; more?: string[] } = {}): string {
	const parent = folder();
	const made = blokctl(parent, ["init", name, ...(options.server ? ["--server", options.server] : [])]);
	if (made.exit !== 0) throw new Error(made.err);
	install(join(parent, name), options.more);
	return join(parent, name);
}
