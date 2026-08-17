import type { ComponentType } from "react";

/**
 * The catalog's page registry — and the reason a wave of parallel agents can
 * each add a catalog page without any of them editing a shared file.
 *
 * Drop `src/catalog/<slug>.tsx` with a default export and it appears in the
 * nav at `/catalog/<slug>`. There is no manifest to append to, so there is no
 * merge conflict to have.
 *
 * `src/catalog/` deliberately sits OUTSIDE `src/routes/`, so TanStack Router's
 * generator never sees these files and `routeTree.gen.ts` stays untouched as
 * pages are added.
 *
 * The glob is non-eager on purpose: that is what produces a real dynamic
 * import and therefore one lazily-loaded chunk per page.
 */
export interface CatalogPage {
	slug: string;
	label: string;
	load: () => Promise<{ default: ComponentType }>;
}

const modules = import.meta.glob<{ default: ComponentType }>("../catalog/*.tsx");

function slugOf(filePath: string): string {
	// `noUncheckedIndexedAccess` is on, so no `split("/").pop()!`.
	return filePath.slice(filePath.lastIndexOf("/") + 1, -".tsx".length);
}

function labelOf(slug: string): string {
	return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
}

export const catalogPages: CatalogPage[] = Object.entries(modules)
	.map(([filePath, load]) => {
		const slug = slugOf(filePath);
		return { slug, label: labelOf(slug), load };
	})
	.sort((a, b) => a.slug.localeCompare(b.slug));
