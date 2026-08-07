import type { UpstreamSource } from "@/lib/upstreamSources";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ForEachEditor, type RawForEach } from "./ForEachEditor";

function renderEditor(
	forEach: RawForEach,
	definition: unknown = { steps: [] },
	sources: UpstreamSource[] = [],
	onSave = vi.fn(),
) {
	render(
		<ForEachEditor
			stepId="iterate"
			forEach={forEach}
			sources={sources}
			definition={definition}
			pending={false}
			onSave={onSave}
			onClose={vi.fn()}
		/>,
	);
	return onSave;
}

describe("ForEachEditor — structural save", () => {
	it("writes in/as from the fields on save, preserving `do` and extra fields", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({
			in: "js/ctx.state.step.items",
			as: "item",
			mode: "parallel",
			concurrency: 5,
			do: [{ id: "inner" }],
		});

		expect(screen.getByText("do: 1 step")).toBeInTheDocument();

		const inInput = screen.getByLabelText("in");
		await user.clear(inInput);
		await user.type(inInput, "js/ctx.state.other.items");

		const asInput = screen.getByLabelText("as");
		await user.clear(asInput);
		await user.type(asInput, "order");

		await user.click(screen.getByRole("button", { name: /save forEach/i }));

		expect(onSave).toHaveBeenCalledWith({
			in: "js/ctx.state.other.items",
			as: "order",
			mode: "parallel",
			concurrency: 5,
			do: [{ id: "inner" }],
		});
	});

	it("requires a non-empty `as`", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ in: "js/ctx.state.step.items", as: "item", do: [] });

		await user.clear(screen.getByLabelText("as"));
		await user.click(screen.getByRole("button", { name: /save forEach/i }));

		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/"as" is required/)).toBeInTheDocument();
	});
});

describe("ForEachEditor — as/asIndex namespace collision footgun", () => {
	it("warns when `as` matches an existing step id elsewhere in the workflow", async () => {
		const user = userEvent.setup();
		const definition = {
			steps: [{ id: "iterate", forEach: { in: "js/ctx.state.a", as: "item", do: [] } }, { id: "order" }],
		};
		renderEditor({ in: "js/ctx.state.a", as: "item", do: [] }, definition);

		await user.clear(screen.getByLabelText("as"));
		await user.type(screen.getByLabelText("as"), "order");

		expect(screen.getByText(/is already used as a step id elsewhere/)).toBeInTheDocument();
	});

	it('warns when `as` + "Index" matches an existing step id', async () => {
		const user = userEvent.setup();
		const definition = {
			steps: [{ id: "iterate", forEach: { in: "js/ctx.state.a", as: "item", do: [] } }, { id: "orderIndex" }],
		};
		renderEditor({ in: "js/ctx.state.a", as: "item", do: [] }, definition);

		await user.clear(screen.getByLabelText("as"));
		await user.type(screen.getByLabelText("as"), "order");

		expect(screen.getByText(/is already used as a step id elsewhere/)).toBeInTheDocument();
	});

	it("shows no warning when `as` is unique", () => {
		const definition = { steps: [{ id: "iterate", forEach: { in: "js/ctx.state.a", as: "item", do: [] } }] };
		renderEditor({ in: "js/ctx.state.a", as: "item", do: [] }, definition);

		expect(screen.queryByText(/is already used as a step id elsewhere/)).not.toBeInTheDocument();
	});
});

describe("ForEachEditor — upstream picker keeps the js/ prefix", () => {
	const sources: UpstreamSource[] = [
		{
			kind: "step",
			id: "fetch-orders",
			ref: "pkg/fetch-orders",
			expr: 'js/ctx.state["fetch-orders"]',
			fields: [{ path: "items", expr: 'js/ctx.state["fetch-orders"].items', type: "array" }],
		},
	];

	it("picking an upstream field inserts the js/-prefixed expression verbatim (forEach.in is mapper-resolved, not raw ctx)", async () => {
		const user = userEvent.setup();
		renderEditor({ in: "", as: "item", do: [] }, { steps: [] }, sources);

		await user.click(screen.getByTitle("Insert a value from an upstream step"));
		await user.click(screen.getByRole("button", { name: "Expand fetch-orders" }));
		await user.click(screen.getByRole("button", { name: "items · array" }));

		expect(screen.getByLabelText("in")).toHaveValue('js/ctx.state["fetch-orders"].items');
	});
});
