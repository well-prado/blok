import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Several CLI test files scaffold a real project and run `bun install` with
// `file:` workspace dependencies. Two vitest workers doing that at once race on
// Bun's global cache entry for the same package (`ENOENT: failed copying files
// from cache to destination for package blokctl`) — a seed-dependent red on
// every CI run that happened to overlap them. One cache per worker process.
// That isolates the destination, but Bun also copies the file: SOURCE tree:
// sibling workers create/delete packages/cli/node_modules/.vite-temp mid-copy
// (#1030). vitest.config.ts runs the Bun scaffold in a later sequence group,
// after all sibling test files finish, with fileParallelism disabled.
if (!process.env.BUN_INSTALL_CACHE_DIR) {
	const dir = mkdtempSync(join(tmpdir(), "blok-cli-bun-cache-"));
	process.env.BUN_INSTALL_CACHE_DIR = dir;
	process.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup of a temp dir
		}
	});
}
