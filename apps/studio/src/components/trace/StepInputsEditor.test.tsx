import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StepInputsEditor, buildFields } from "./StepInputsEditor";

const schema = {
	type: "object",
	properties: {
		expression: { type: "string", description: "JS expression to evaluate" },
		timeoutMs: { type: "number" },
		sensitive: { type: "boolean" },
		mode: { type: "string", enum: ["exact", "contains"] },
		locator: { type: "object" },
	},
	required: ["expression"],
};

function renderEditor(inputs: Record<string, unknown> = {}, onSave = vi.fn()) {
	render(
		<StepInputsEditor
			stepId="respond"
			schema={schema}
			inputs={inputs}
			pending={false}
			onSave={onSave}
			onClose={vi.fn()}
		/>,
	);
	return onSave;
}

describe("buildFields", () => {
	it("maps schema properties to typed fields with required markers", () => {
		expect(buildFields(schema)).toEqual([
			{
				name: "expression",
				kind: "string",
				required: true,
				description: "JS expression to evaluate",
				options: undefined,
			},
			{ name: "timeoutMs", kind: "number", required: false, description: undefined, options: undefined },
			{ name: "sensitive", kind: "boolean", required: false, description: undefined, options: undefined },
			{ name: "mode", kind: "enum", required: false, description: undefined, options: ["exact", "contains"] },
			{ name: "locator", kind: "json", required: false, description: undefined, options: undefined },
		]);
	});

	it("returns no fields for a missing or empty schema", () => {
		expect(buildFields(undefined)).toEqual([]);
		expect(buildFields({})).toEqual([]);
	});
});

describe("StepInputsEditor", () => {
	it("saves typed values: strings verbatim, numbers parsed, blanks omitted, JSON parsed", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor();

		await user.type(screen.getByLabelText(/expression/), "({{ ok: true })");
		await user.type(screen.getByLabelText(/timeoutMs/), "1500");
		await user.selectOptions(screen.getByLabelText(/sensitive/), "true");
		await user.type(screen.getByLabelText(/locator/), '{{"by": "label", "value": "Email"}');
		await user.click(screen.getByRole("button", { name: /save inputs/i }));

		expect(onSave).toHaveBeenCalledWith({
			expression: "({ ok: true })",
			timeoutMs: 1500,
			sensitive: true,
			locator: { by: "label", value: "Email" },
		});
	});

	it("keeps js/ expressions as strings on number fields and rejects garbage", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor();

		await user.type(screen.getByLabelText(/timeoutMs/), "js/ctx.request.body.timeout");
		await user.click(screen.getByRole("button", { name: /save inputs/i }));
		expect(onSave).toHaveBeenCalledWith({ timeoutMs: "js/ctx.request.body.timeout" });

		onSave.mockClear();
		await user.clear(screen.getByLabelText(/timeoutMs/));
		await user.type(screen.getByLabelText(/timeoutMs/), "not-a-number");
		await user.click(screen.getByRole("button", { name: /save inputs/i }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/not a number/i)).toBeInTheDocument();
	});

	it("preserves inputs the schema does not describe", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ session: "js/ctx.state.launch", expression: "1" });

		await user.click(screen.getByRole("button", { name: /save inputs/i }));

		expect(onSave).toHaveBeenCalledWith({ session: "js/ctx.state.launch", expression: "1" });
	});

	it("blocks invalid raw JSON and saves valid raw JSON", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ expression: "1" });

		await user.click(screen.getByRole("button", { name: /raw json/i }));
		const textarea = screen.getByLabelText("Raw inputs JSON");
		await user.clear(textarea);
		await user.type(textarea, "not json");
		await user.click(screen.getByRole("button", { name: /save inputs/i }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/invalid json/i)).toBeInTheDocument();

		await user.clear(textarea);
		await user.type(textarea, '{{"expression": "2"}');
		await user.click(screen.getByRole("button", { name: /save inputs/i }));
		expect(onSave).toHaveBeenCalledWith({ expression: "2" });
	});
});
