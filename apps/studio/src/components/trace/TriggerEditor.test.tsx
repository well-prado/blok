import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TriggerEditor } from "./TriggerEditor";

function renderEditor(trigger: Record<string, unknown>, onSave = vi.fn()) {
	render(<TriggerEditor trigger={trigger} pending={false} onSave={onSave} onClose={vi.fn()} />);
	return onSave;
}

describe("TriggerEditor", () => {
	it("edits http fields and preserves knobs the form does not render", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({
			http: { method: "GET", path: "/old", accept: "application/json", middleware: ["auth-check"] },
		});

		const path = screen.getByLabelText(/path/);
		await user.clear(path);
		await user.type(path, "/new-route");
		await user.selectOptions(screen.getByLabelText(/method/), "POST");
		await user.click(screen.getByRole("button", { name: /save trigger/i }));

		expect(onSave).toHaveBeenCalledWith({
			http: { method: "POST", path: "/new-route", accept: "application/json", middleware: ["auth-check"] },
		});
	});

	it("switches the trigger kind and emits the new shape", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ http: { method: "GET", path: "/x" } });

		await user.selectOptions(screen.getByLabelText("Type"), "cron");
		await user.type(screen.getByLabelText(/schedule/), "0 * * * *");
		await user.selectOptions(screen.getByLabelText(/overlap/), "true");
		await user.click(screen.getByRole("button", { name: /save trigger/i }));

		expect(onSave).toHaveBeenCalledWith({ cron: { schedule: "0 * * * *", overlap: true } });
	});

	it("falls back to raw JSON for kinds without a form and blocks invalid JSON", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ http: { method: "GET", path: "/x" } });

		await user.selectOptions(screen.getByLabelText("Type"), "websocket");
		const textarea = screen.getByLabelText("Raw trigger JSON");
		await user.clear(textarea);
		await user.type(textarea, "nope");
		await user.click(screen.getByRole("button", { name: /save trigger/i }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/invalid json/i)).toBeInTheDocument();

		await user.clear(textarea);
		await user.type(textarea, '{{"websocket": {{"path": "/ws"}}');
		await user.click(screen.getByRole("button", { name: /save trigger/i }));
		expect(onSave).toHaveBeenCalledWith({ websocket: { path: "/ws" } });
	});
});
