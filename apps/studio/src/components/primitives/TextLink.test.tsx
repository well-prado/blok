import { TextLink } from "@/components/primitives/TextLink";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

// TanStack's <Link> reads a router from context. The cheapest real one: a single
// root route that renders the subject, on an in-memory history.
function renderInRouter(ui: ReactNode) {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => <>{ui}</> }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	// `Register` in main.tsx pins RouterProvider to the app's own route tree; a
	// test tree is a different type by construction.
	render(<RouterProvider router={router as never} />);
	return router;
}

describe("TextLink", () => {
	it("navigates in-app through the router for an internal href", async () => {
		const router = renderInRouter(<TextLink href="/runs">Runs</TextLink>);
		const link = await screen.findByRole("link", { name: "Runs" });
		expect(link).toHaveAttribute("href", "/runs");
		expect(link).not.toHaveAttribute("target");

		await userEvent.click(link);
		expect(router.state.location.pathname).toBe("/runs");
	});

	it("opens an external href in a new tab, safely, and says so", () => {
		const { container } = render(<TextLink href="https://blok.dev/docs">Docs</TextLink>);
		// The accessible name carries the warning, not just the icon.
		const link = screen.getByRole("link", { name: /^Docs\s*\(opens in a new tab\)$/ });
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		// The affordance is decorative; the sr-only text is what carries the meaning.
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("falls back to a plain anchor with no router in context", () => {
		// Catalog pages and any bare render mount outside a RouterProvider; the
		// link must degrade, not crash.
		render(<TextLink href="/runs">Runs</TextLink>);
		const link = screen.getByRole("link", { name: "Runs" });
		expect(link).toHaveAttribute("href", "/runs");
		expect(link).not.toHaveAttribute("target");
	});

	it("applies the variant", () => {
		render(<TextLink href="mailto:hi@blok.dev">Email</TextLink>);
		render(
			<TextLink href="mailto:hi@blok.dev" variant="secondary">
				Email secondary
			</TextLink>,
		);
		// A scheme means external, so these stay plain anchors and need no router.
		expect(screen.getByRole("link", { name: /^Email\s*\(/ })).toHaveClass("text-accent");
		expect(screen.getByRole("link", { name: /^Email secondary/ })).toHaveClass("text-ink-dimmed");
	});
});
