/**
 * `describe` / `it` / `expect` from whichever runner is executing this fixture.
 *
 * The acceptance bar for #688 is that a consumer's tests run under BOTH
 * `vitest run` and `bun test` with no Blok-specific configuration, so the
 * fixture must not hard-code one runner's import. A real consumer project picks
 * one runner and imports it directly — this indirection exists only because the
 * fixture has to prove both.
 */
type Describe = typeof import("vitest").describe;
type It = typeof import("vitest").it;
type Expect = typeof import("vitest").expect;

const specifier = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "vitest" : "bun:test";
const api = (await import(/* @vite-ignore */ specifier)) as unknown as {
	describe: Describe;
	it: It;
	expect: Expect;
};

export const describe = api.describe;
export const it = api.it;
export const expect = api.expect;
