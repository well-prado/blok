/**
 * Page titles, for Svelte only.
 *
 * `@inertiajs/svelte` has no `<Head>` component and its `createInertiaApp()`
 * hard-codes the head manager's title resolver to identity, so the `title:`
 * callback that React and Vue use is dead config here. Every Svelte page
 * therefore writes its own `<svelte:head><title>` — and builds it from THIS
 * helper, so the suffix lives in one place instead of in every page.
 */
export const APP_NAME = "Blok";

export function pageTitle(title?: string): string {
	return title === undefined || title === "" ? APP_NAME : `${title} · ${APP_NAME}`;
}
