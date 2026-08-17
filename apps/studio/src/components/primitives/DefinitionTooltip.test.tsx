import { BLOK_GLOSSARY, DefinitionTooltip } from "@/components/primitives/DefinitionTooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

describe("DefinitionTooltip", () => {
	it("labels the trigger with the glossary term by default", () => {
		render(<DefinitionTooltip term="subworkflow" />);
		expect(screen.getByRole("button", { name: "Subworkflow" })).toBeInTheDocument();
	});

	it("lets prose override the visible word without changing the definition", async () => {
		const user = userEvent.setup();
		render(<DefinitionTooltip term="node">nodes</DefinitionTooltip>);

		await user.tab();
		expect(await screen.findByRole("tooltip")).toHaveTextContent(BLOK_GLOSSARY.node.definition);
	});

	it("reveals the definition on keyboard focus and hides it on Escape", async () => {
		const user = userEvent.setup();
		render(<DefinitionTooltip term="idempotencyKey" />);

		await user.tab();
		expect(await screen.findByRole("tooltip")).toHaveTextContent(BLOK_GLOSSARY.idempotencyKey.definition);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});
});
