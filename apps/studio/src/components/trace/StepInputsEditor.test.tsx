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

describe("Settings tab", () => {
	function renderWithSettings(settings: Record<string, unknown> = {}, onSaveSettings = vi.fn(), onSave = vi.fn()) {
		render(
			<StepInputsEditor
				stepId="respond"
				schema={schema}
				inputs={{}}
				pending={false}
				onSave={onSave}
				onClose={vi.fn()}
				settings={settings}
				onSaveSettings={onSaveSettings}
			/>,
		);
		return { onSave, onSaveSettings };
	}

	it("does not render when settings/onSaveSettings are absent", () => {
		renderEditor();
		expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
	});

	it("switches to the Settings tab and shows the reliability/state fields", async () => {
		const user = userEvent.setup();
		renderWithSettings();

		await user.click(screen.getByRole("tab", { name: "Settings" }));

		expect(screen.getByLabelText("as")).toBeInTheDocument();
		expect(screen.getByLabelText("spread")).toBeInTheDocument();
		expect(screen.getByLabelText("ephemeral")).toBeInTheDocument();
		expect(screen.getByLabelText("idempotencyKey")).toBeInTheDocument();
		expect(screen.getByLabelText("maxAttempts")).toBeInTheDocument();
		expect(screen.getByLabelText("maxDuration")).toBeInTheDocument();
	});

	it("setting `as` clears and disables `spread`, and vice versa, with the reason shown", async () => {
		const user = userEvent.setup();
		renderWithSettings();
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		await user.type(screen.getByLabelText("as"), "users");
		expect(screen.getByLabelText("spread")).toBeDisabled();
		expect(screen.getByText(/mutually exclusive with `as`/)).toBeInTheDocument();

		await user.clear(screen.getByLabelText("as"));
		await user.click(screen.getByLabelText("spread"));
		expect(screen.getByLabelText("spread")).toBeChecked();
		expect(screen.getByLabelText("as")).toBeDisabled();
		expect(screen.getByLabelText("as")).toHaveValue("");
		expect(screen.getByText(/mutually exclusive with `spread`/)).toBeInTheDocument();
	});

	it("shows the ephemeral footgun warning only when ephemeral is on", async () => {
		const user = userEvent.setup();
		renderWithSettings();
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		expect(screen.queryByText(/downstream steps cannot read this step's handle/)).not.toBeInTheDocument();
		await user.click(screen.getByLabelText("ephemeral"));
		expect(screen.getByText(/downstream steps cannot read this step's handle/)).toBeInTheDocument();
	});

	it("omits blank/default fields from the saved settings object", async () => {
		const user = userEvent.setup();
		const { onSaveSettings } = renderWithSettings();
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		await user.click(screen.getByRole("button", { name: /save settings/i }));

		expect(onSaveSettings).toHaveBeenCalledWith({});
	});

	it("saves only the set knobs, typed per schema", async () => {
		const user = userEvent.setup();
		const { onSaveSettings } = renderWithSettings();
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		await user.type(screen.getByLabelText("as"), "users");
		await user.click(screen.getByLabelText("ephemeral"));
		await user.type(screen.getByLabelText("idempotencyKey"), "js/ctx.request.body.requestId");
		await user.type(screen.getByLabelText("maxAttempts"), "3");
		await user.type(screen.getByLabelText("maxDuration"), "30s");
		await user.click(screen.getByRole("button", { name: /save settings/i }));

		expect(onSaveSettings).toHaveBeenCalledWith({
			as: "users",
			ephemeral: true,
			idempotencyKey: "js/ctx.request.body.requestId",
			retry: { maxAttempts: 3 },
			maxDuration: "30s",
		});
	});

	it("blocks save on an invalid maxDuration and shows the message", async () => {
		const user = userEvent.setup();
		const { onSaveSettings } = renderWithSettings();
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		await user.type(screen.getByLabelText("maxDuration"), "thirty-seconds");
		await user.click(screen.getByRole("button", { name: /save settings/i }));

		expect(onSaveSettings).not.toHaveBeenCalled();
		expect(screen.getByText(/maxDuration must be/)).toBeInTheDocument();
	});

	it("blocks save on an invalid retry shape and shows the message", async () => {
		const user = userEvent.setup();
		const { onSaveSettings } = renderWithSettings();
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		await user.type(screen.getByLabelText("minTimeoutInMs"), "1000");
		await user.click(screen.getByRole("button", { name: /save settings/i }));

		expect(onSaveSettings).not.toHaveBeenCalled();
		expect(screen.getByText(/retry.maxAttempts is required/)).toBeInTheDocument();
	});

	it("hydrates fields from the current settings prop", async () => {
		const user = userEvent.setup();
		renderWithSettings({ spread: true, retry: { maxAttempts: 5, factor: 2 } });
		await user.click(screen.getByRole("tab", { name: "Settings" }));

		expect(screen.getByLabelText("spread")).toBeChecked();
		expect(screen.getByLabelText("maxAttempts")).toHaveValue("5");
		expect(screen.getByLabelText("factor")).toHaveValue("2");
	});
});

describe("upstream picker", () => {
	const definition = {
		trigger: { http: { method: "POST", path: "/x" } },
		steps: [
			{ id: "fetch-user", use: "pkg/fetch-user", inputs: {} },
			{ id: "respond", use: "pkg/respond", inputs: {} },
		],
	};
	const catalog = [
		{
			name: "Fetch user",
			ref: "pkg/fetch-user",
			outputSchema: { properties: { email: { type: "string" } } },
		},
	];

	function renderWithPicker() {
		const onSave = vi.fn();
		render(
			<StepInputsEditor
				stepId="respond"
				schema={schema}
				inputs={{}}
				pending={false}
				onSave={onSave}
				onClose={vi.fn()}
				definition={definition}
				catalog={catalog}
			/>,
		);
		return onSave;
	}

	/** The first field's picker button — opens/closes that field's popover. */
	function firstPickerButton(): HTMLElement {
		const [button] = screen.getAllByTitle("Insert a value from an upstream step");
		if (!button) throw new Error("expected at least one picker button");
		return button;
	}

	it("renders a picker button per field", () => {
		renderWithPicker();
		expect(screen.getAllByTitle("Insert a value from an upstream step")).toHaveLength(buildFields(schema).length);
	});

	it("opening the picker lists the trigger and every upstream step", async () => {
		const user = userEvent.setup();
		renderWithPicker();

		await user.click(firstPickerButton());

		expect(screen.getByRole("button", { name: /^trigger/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^fetch-user/ })).toBeInTheDocument();
	});

	it("clicking a field entry writes the expression into the field's value", async () => {
		const user = userEvent.setup();
		renderWithPicker();

		await user.click(firstPickerButton());
		await user.click(screen.getByRole("button", { name: "Expand fetch-user" }));
		await user.click(screen.getByRole("button", { name: "email · string" }));

		expect(screen.getByLabelText(/expression/)).toHaveValue('js/ctx.state["fetch-user"].email');
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		renderWithPicker();

		await user.click(firstPickerButton());
		expect(screen.getByRole("menu")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});
});
