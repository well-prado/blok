import { Button, LinkButton } from "@/components/primitives/Buttons";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Three assertions per primitive, semantic signals over class strings
// (`_design/CONVENTIONS.md` §8.3).
describe("Button", () => {
	it("renders its accessible name", () => {
		render(<Button>Deploy</Button>);
		expect(screen.getByRole("button", { name: "Deploy" })).toBeInTheDocument();
	});

	it("does not fire its handler while disabled", async () => {
		const onClick = vi.fn();
		render(
			<Button disabled onClick={onClick}>
				Deploy
			</Button>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Deploy" }));
		expect(onClick).not.toHaveBeenCalled();
	});

	it("marks itself busy and blocks a second submit while loading", async () => {
		const onClick = vi.fn();
		render(
			<Button isLoading onClick={onClick}>
				Deploy
			</Button>,
		);
		const button = screen.getByRole("button", { name: "Deploy" });
		expect(button).toHaveAttribute("aria-busy", "true");
		await userEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("renders the shortcut hint visibly but hides it from assistive tech", () => {
		render(<Button shortcut="⌘K">Search</Button>);
		// The name stays "Search" — the cap is decorative because nothing binds it.
		expect(screen.getByRole("button", { name: "Search" })).toHaveTextContent("⌘K");
		expect(screen.getByText("⌘K")).toHaveAttribute("aria-hidden", "true");
	});
});

describe("LinkButton", () => {
	it("renders a real link with the routed href", async () => {
		const rootRoute = createRootRoute({
			component: () => <LinkButton to="/">Dashboard</LinkButton>,
		});
		const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
		render(<RouterProvider router={router} />);

		expect(await screen.findByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
	});
});
