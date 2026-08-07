import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RawSubworkflowStep, SubworkflowEditor } from "./SubworkflowEditor";

const mocks = vi.hoisted(() => ({
	workflows: [] as Array<{ name: string }>,
	isLoading: false,
}));

vi.mock("@/hooks/useWorkflows", () => ({
	useWorkflows: () => ({ data: mocks.workflows, isLoading: mocks.isLoading }),
}));

function renderEditor(step: RawSubworkflowStep, currentWorkflowName = "parent-workflow", onSave = vi.fn()) {
	render(
		<SubworkflowEditor
			stepId="call-child"
			step={step}
			currentWorkflowName={currentWorkflowName}
			pending={false}
			onSave={onSave}
			onClose={vi.fn()}
		/>,
	);
	return onSave;
}

describe("SubworkflowEditor — structural save", () => {
	beforeEach(() => {
		mocks.workflows = [{ name: "send-receipt-email" }, { name: "parent-workflow" }];
		mocks.isLoading = false;
	});

	it("picks the target from the workflow list and writes subworkflow/inputs/wait/dispatch, preserving untouched step fields", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({
			id: "call-child",
			subworkflow: "send-receipt-email",
			inputs: { user: "js/ctx.state.user" },
			wait: true,
			dispatch: "in-process",
			active: false,
		});

		expect(screen.getByLabelText("Target workflow")).toHaveValue("send-receipt-email");

		await user.click(screen.getByRole("button", { name: /save subworkflow/i }));

		expect(onSave).toHaveBeenCalledWith({
			id: "call-child",
			subworkflow: "send-receipt-email",
			inputs: { user: "js/ctx.state.user" },
			wait: true,
			dispatch: "in-process",
			active: false,
		});
	});

	it("writes wait:false and dispatch:http-self when selected", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ subworkflow: "send-receipt-email" });

		await user.selectOptions(screen.getByLabelText("wait"), "false");
		await user.selectOptions(screen.getByLabelText("dispatch"), "http-self");
		await user.click(screen.getByRole("button", { name: /save subworkflow/i }));

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ wait: false, dispatch: "http-self" }));
	});

	it("requires a target workflow before saving", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({});

		await user.click(screen.getByRole("button", { name: /save subworkflow/i }));

		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/choose a workflow/i)).toBeInTheDocument();
	});

	it("rejects invalid inputs JSON before saving", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ subworkflow: "send-receipt-email", inputs: {} });

		const textarea = screen.getByLabelText("inputs");
		await user.clear(textarea);
		await user.type(textarea, "not valid json");
		await user.click(screen.getByRole("button", { name: /save subworkflow/i }));

		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/invalid inputs json/i)).toBeInTheDocument();
	});
});

describe("SubworkflowEditor — raw fallback for polymorphic dispatch", () => {
	beforeEach(() => {
		mocks.workflows = [{ name: "send-receipt-email" }, { name: "parent-workflow" }];
		mocks.isLoading = false;
	});

	it("opens in Custom mode when the target isn't a known workflow (an expression), preserving it verbatim", () => {
		renderEditor({ subworkflow: "js/ctx.req.body.kind" });

		expect(screen.getByLabelText("Custom workflow name or expression")).toHaveValue("js/ctx.req.body.kind");
	});

	it("saves the custom expression verbatim", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ subworkflow: "js/ctx.req.body.kind" });

		await user.click(screen.getByRole("button", { name: /save subworkflow/i }));

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ subworkflow: "js/ctx.req.body.kind" }));
	});
});

describe("SubworkflowEditor — self-recursion guard", () => {
	beforeEach(() => {
		mocks.workflows = [{ name: "send-receipt-email" }, { name: "parent-workflow" }];
		mocks.isLoading = false;
	});

	it("warns when the target is the CURRENT workflow", () => {
		renderEditor({ subworkflow: "parent-workflow" }, "parent-workflow");

		expect(screen.getByText(/self-recursive call/i)).toBeInTheDocument();
	});

	it("shows no warning for a different target", () => {
		renderEditor({ subworkflow: "send-receipt-email" }, "parent-workflow");

		expect(screen.queryByText(/self-recursive call/i)).not.toBeInTheDocument();
	});
});
