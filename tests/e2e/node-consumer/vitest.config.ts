import { defineConfig } from "vitest/config";

/**
 * Deliberately empty (#687).
 *
 * The whole point of this fixture is that a downstream project needs NO
 * configuration to import `@blokjs/*` under vitest. In particular there must
 * never be a
 *
 *   server: { deps: { inline: [/@blokjs\//] } }
 *
 * here — that workaround routes the packages through Vite's bundler
 * resolution, which papers over exactly the extensionless-import bug this
 * fixture exists to catch. If a future change makes this file need options to
 * go green, the packaging is broken, not the config.
 */
export default defineConfig({});
