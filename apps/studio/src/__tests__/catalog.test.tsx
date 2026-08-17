import { catalogPages } from "@/lib/catalogPages";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// Guards the mechanism, not the pages: if the glob in `catalogPages.ts` stops
// discovering `src/catalog/*.tsx`, every downstream task's page silently
// vanishes from the catalog with no other test noticing.
describe("catalog auto-discovery", () => {
	// `it.each([])` produces ZERO tests and vitest reports that as a pass, so the
	// suite below is only meaningful with this assertion in front of it.
	it("discovers at least one page", () => {
		expect(catalogPages.length).toBeGreaterThan(0);
	});

	it("includes the foundation page", () => {
		expect(catalogPages.map((p) => p.slug)).toContain("foundation");
	});

	it("derives a slug and a label for every page", () => {
		for (const page of catalogPages) {
			expect(page.slug).toMatch(/^[a-z0-9-]+$/);
			expect(page.label.length).toBeGreaterThan(0);
		}
	});

	// Mounting the router would read the committed `routeTree.gen.ts` (vitest does
	// not load TanStackRouterVite), so import the page modules directly instead.
	it.each(catalogPages.map((p) => [p.slug, p] as const))("%s renders with a heading", async (_slug, page) => {
		const mod = await page.load();
		expect(mod.default).toBeTypeOf("function");
		render(<mod.default />);
		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
	});
});
