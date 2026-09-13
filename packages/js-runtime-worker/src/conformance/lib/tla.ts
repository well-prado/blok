/** Top-level await in a dependency of the node module. If an engine cannot
 * load this, every node in the file is unreachable — which is exactly the
 * failure mode this fixture exists to surface. */
export const TOP_LEVEL_AWAIT = await Promise.resolve("top-level-await-ok");
