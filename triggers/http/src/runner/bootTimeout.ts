/**
 * #873 — one bound for every foreign promise awaited on the boot path.
 *
 * Fourth instance of the same defect in this trigger (#752/PR #865 —
 * `listen()`'s bind; #868/PR #872 — `listNodes()`; plus the two in #873 —
 * `Workflows.ts` entries and pre-catch-all hooks), so the race lives here
 * instead of being open-coded a fifth time. The rule it enforces:
 *
 *   an await on the boot path must be able to FAIL, not only hang.
 *
 * `bounded()` guarantees only that the await ENDS — the caller decides the
 * consequence (fail boot vs. log-and-degrade), same as it already decides what
 * a rejection means. Expiry is reported as a rejection naming `what`, so a
 * timeout flows through the caller's existing error handling and its message
 * says which thing wedged.
 *
 * ponytail: local to `triggers/http` because all four call sites are here;
 * move it to `@blokjs/shared` the first time another package needs it.
 */
export function bounded<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
