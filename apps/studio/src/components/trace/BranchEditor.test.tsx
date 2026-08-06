import type { UpstreamSource } from "@/lib/upstreamSources";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchEditor, type RawBranch } from "./BranchEditor";

function renderEditor(branch: RawBranch, sources: UpstreamSource[] = [], onSave = vi.fn()) {
	render(
		<BranchEditor
			stepId="decide"
			branch={branch}
			sources={sources}
			pending={false}
			onSave={onSave}
			onClose={vi.fn()}
		/>,
	);
	return onSave;
}

describe("BranchEditor — structural mode", () => {
	it("builds the lowered `when` from the structured fields on save, preserving then/else", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ when: "ctx.state.a.ok", then: [{ id: "t1" }], else: [{ id: "e1" }] });

		expect(screen.getByText(/then: 1 step · else: 1 step/)).toBeInTheDocument();

		const leftInput = screen.getByLabelText("Left operand");
		await user.clear(leftInput);
		await user.type(leftInput, "ctx.state.a.count");
		await user.selectOptions(screen.getByLabelText("Comparator"), ">");
		await user.type(screen.getByLabelText("Right operand"), "5");

		expect(screen.getByText("ctx.state.a.count > 5")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /save condition/i }));

		expect(onSave).toHaveBeenCalledWith({
			when: "ctx.state.a.count > 5",
			then: [{ id: "t1" }],
			else: [{ id: "e1" }],
		});
	});

	it("negates the whole comparison when Negate is checked", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ when: "ctx.state.a.count > ctx.state.b.limit" });

		await user.click(screen.getByLabelText(/negate/i));
		await user.click(screen.getByRole("button", { name: /save condition/i }));

		expect(onSave).toHaveBeenCalledWith({ when: "!(ctx.state.a.count > ctx.state.b.limit)" });
	});
});

describe("BranchEditor — raw fallback", () => {
	it("opens in raw mode for an unparseable condition, preserving the original text", () => {
		const when = 'ctx.request.method.toLowerCase() === "get" && ctx.request.params.function === undefined';
		renderEditor({ when, then: [], else: [] });

		expect(screen.getByLabelText("Raw condition JS")).toHaveValue(when);
		expect(screen.getByText(/too complex/i)).toBeInTheDocument();
		expect(screen.getByText(/then: 0 steps · else: 0 steps/)).toBeInTheDocument();
	});

	it("saves the edited raw text verbatim", async () => {
		const user = userEvent.setup();
		const when = "ctx.state.a.ok && ctx.state.b.ok";
		const onSave = renderEditor({ when });

		const textarea = screen.getByLabelText("Raw condition JS");
		await user.clear(textarea);
		await user.type(textarea, `${when} && ctx.state.c.ok`);
		await user.click(screen.getByRole("button", { name: /save condition/i }));

		expect(onSave).toHaveBeenCalledWith({ when: `${when} && ctx.state.c.ok` });
	});
});

describe("BranchEditor — upstream picker", () => {
	const sources: UpstreamSource[] = [
		{
			kind: "step",
			id: "fetch-user",
			ref: "pkg/fetch-user",
			expr: 'js/ctx.state["fetch-user"]',
			fields: [{ path: "email", expr: 'js/ctx.state["fetch-user"].email', type: "string" }],
		},
	];

	it("picking an upstream field inserts an unprefixed ctx expression", async () => {
		const user = userEvent.setup();
		renderEditor({ when: "" }, sources);

		// An empty `when` has nothing to parse, so it starts in raw mode —
		// switch to the structural editor first.
		await user.click(screen.getByRole("button", { name: /structured/i }));
		await user.click(screen.getByTitle("Insert a value from an upstream step"));
		await user.click(screen.getByRole("button", { name: "Expand fetch-user" }));
		await user.click(screen.getByRole("button", { name: "email · string" }));

		expect(screen.getByLabelText("Left operand")).toHaveValue('ctx.state["fetch-user"].email');
	});
});
