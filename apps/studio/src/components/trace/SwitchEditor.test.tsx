import type { UpstreamSource } from "@/lib/upstreamSources";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type RawSwitch, SwitchEditor } from "./SwitchEditor";

function renderEditor(switchConfig: RawSwitch, sources: UpstreamSource[] = [], onSave = vi.fn()) {
	render(
		<SwitchEditor
			stepId="route"
			switchConfig={switchConfig}
			sources={sources}
			pending={false}
			onSave={onSave}
			onClose={vi.fn()}
		/>,
	);
	return onSave;
}

describe("SwitchEditor — structural save", () => {
	it("writes on + case `when` literals on save, preserving each case's `do` and `default`", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({
			on: "js/ctx.state.item.type",
			cases: [
				{ when: "physical", do: [{ id: "ship" }] },
				{ when: "digital", do: [{ id: "deliver" }] },
			],
			default: [{ id: "fallback" }],
		});

		expect(screen.getByText("default: 1 step")).toBeInTheDocument();

		const onInput = screen.getByLabelText("on");
		await user.clear(onInput);
		await user.type(onInput, "js/ctx.state.item.kind");

		await user.click(screen.getByRole("button", { name: /save switch/i }));

		expect(onSave).toHaveBeenCalledWith({
			on: "js/ctx.state.item.kind",
			cases: [
				{ when: "physical", do: [{ id: "ship" }] },
				{ when: "digital", do: [{ id: "deliver" }] },
			],
			default: [{ id: "fallback" }],
		});
	});

	it("parses a numeric case value to a number literal", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ on: "js/ctx.state.n", cases: [{ when: 1, do: [{ id: "a" }] }] });

		const caseInput = screen.getByLabelText("Case 1 value");
		await user.clear(caseInput);
		await user.type(caseInput, "42");
		await user.click(screen.getByRole("button", { name: /save switch/i }));

		expect(onSave).toHaveBeenCalledWith({
			on: "js/ctx.state.n",
			cases: [{ when: 42, do: [{ id: "a" }] }],
		});
	});

	it("requires at least one case", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ on: "js/ctx.state.n", cases: [{ when: "a", do: [{ id: "a" }] }] });

		await user.click(screen.getByTitle(/Removing this case deletes/));
		await user.click(screen.getByRole("button", { name: /confirm/i }));
		await user.click(screen.getByRole("button", { name: /save switch/i }));

		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/at least one case is required/i)).toBeInTheDocument();
	});
});

describe("SwitchEditor — add/remove case rows", () => {
	it("adding a case appends an empty { when: '', do: [] } row", async () => {
		const user = userEvent.setup();
		renderEditor({ on: "js/ctx.state.n", cases: [{ when: "a", do: [{ id: "a" }] }] });

		await user.click(screen.getByRole("button", { name: /add case/i }));

		expect(screen.getByLabelText("Case 2 value")).toHaveValue("");
		expect(screen.getByText("0 steps")).toBeInTheDocument();
	});

	it("removes an empty case immediately, no confirmation needed", async () => {
		const user = userEvent.setup();
		renderEditor({
			on: "js/ctx.state.n",
			cases: [
				{ when: "a", do: [] },
				{ when: "b", do: [{ id: "b" }] },
			],
		});

		await user.click(screen.getAllByTitle("Remove case")[0] as HTMLElement);

		expect(screen.queryByDisplayValue("a")).not.toBeInTheDocument();
		expect(screen.getByDisplayValue("b")).toBeInTheDocument();
	});

	it("removing a non-empty case requires a second confirming click", async () => {
		const user = userEvent.setup();
		renderEditor({
			on: "js/ctx.state.n",
			cases: [
				{ when: "a", do: [{ id: "a" }] },
				{ when: "b", do: [] },
			],
		});

		const removeButton = screen.getByTitle(/Removing this case deletes/);
		await user.click(removeButton);
		// First click just arms the confirmation — the case row is still there.
		expect(screen.getByDisplayValue("a")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /confirm/i }));
		expect(screen.queryByDisplayValue("a")).not.toBeInTheDocument();
	});
});

describe("SwitchEditor — upstream picker keeps the js/ prefix", () => {
	const sources: UpstreamSource[] = [
		{
			kind: "step",
			id: "fetch-item",
			ref: "pkg/fetch-item",
			expr: 'js/ctx.state["fetch-item"]',
			fields: [{ path: "type", expr: 'js/ctx.state["fetch-item"].type', type: "string" }],
		},
	];

	it("picking an upstream field inserts the js/-prefixed expression verbatim (switch.on is mapper-resolved, not raw ctx)", async () => {
		const user = userEvent.setup();
		renderEditor({ on: "", cases: [{ when: "a", do: [] }] }, sources);

		await user.click(screen.getByTitle("Insert a value from an upstream step"));
		await user.click(screen.getByRole("button", { name: "Expand fetch-item" }));
		await user.click(screen.getByRole("button", { name: "type · string" }));

		expect(screen.getByLabelText("on")).toHaveValue('js/ctx.state["fetch-item"].type');
	});
});
