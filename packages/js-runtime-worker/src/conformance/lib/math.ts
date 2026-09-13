/** Imported with an explicit `./math.js` specifier — the Node-ESM spelling that
 * Bun rewrites and Deno needs `--sloppy-imports` for when only `.ts` exists.
 * Compiled into `dist/`, so all three engines resolve the real `.js`. */
export function add(left: number, right: number): number {
	return left + right;
}
