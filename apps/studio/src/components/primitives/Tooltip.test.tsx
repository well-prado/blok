import { InfoIconTooltip, SimpleTooltip } from "@/components/primitives/Tooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

// Radix positions via floating-ui, which calls `ResizeObserver`. jsdom has none
// and `src/__tests__/setup.ts` is frozen, so the stub lives here.
beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

describe("SimpleTooltip", () => {
	it("opens on keyboard focus, not hover only", async () => {
		const user = userEvent.setup();
		render(<SimpleTooltip button="Retries" content="How many times this step re-ran." />);

		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		await user.tab();
		expect(screen.getByRole("button", { name: "Retries" })).toHaveFocus();
		expect(await screen.findByRole("tooltip")).toHaveTextContent("How many times this step re-ran.");
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		render(<SimpleTooltip button="Retries" content="How many times this step re-ran." />);

		await user.tab();
		expect(await screen.findByRole("tooltip")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("describes its trigger rather than renaming it", async () => {
		const user = userEvent.setup();
		render(<SimpleTooltip button="Retries" content="How many times this step re-ran." />);

		await user.tab();
		await screen.findByRole("tooltip");
		// Radix wires aria-describedby, so the trigger keeps its own name.
		expect(screen.getByRole("button", { name: "Retries" })).toHaveAttribute("aria-describedby");
	});
});

describe("InfoIconTooltip", () => {
	it("gives its icon-only trigger an accessible name and hides the glyph", () => {
		const { container } = render(<InfoIconTooltip label="About retries" content="Retry policy for this step." />);

		expect(screen.getByRole("button", { name: "About retries" })).toBeInTheDocument();
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("defaults to the md glyph row (CONVENTIONS §2.4)", () => {
		// Nothing rendered InfoIconTooltip WITHOUT a size prop, so its default
		// silently sat at `sm` (14px) while every sibling default was `md` (16px)
		// — the vertical-alignment failure §2.4 exists to prevent.
		const { container } = render(<InfoIconTooltip content="Retry policy for this step." />);
		expect(container.querySelector("svg")).toHaveClass("h-4");
	});

	it("applies the glyph size row", () => {
		const { container } = render(<InfoIconTooltip size="lg" content="Retry policy for this step." />);
		// No semantic signal distinguishes sizes, so exactly one discriminating class.
		expect(container.querySelector("svg")).toHaveClass("h-5");
	});
});
