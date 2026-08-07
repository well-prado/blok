import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type RawTryCatch, TryCatchEditor } from "./TryCatchEditor";

function renderEditor(tryCatch: RawTryCatch, onClose = vi.fn()) {
	render(<TryCatchEditor stepId="saga" tryCatch={tryCatch} onClose={onClose} />);
	return onClose;
}

describe("TryCatchEditor — informative panel (no editable fields)", () => {
	it("shows the try/catch/finally arm step counts", () => {
		renderEditor({
			try: [{ id: "create" }, { id: "notify" }],
			catch: [{ id: "rollback" }],
			finally: [{ id: "metric" }],
		});

		expect(screen.getByText(/try: 2 steps · catch: 1 step · finally: 1 step/)).toBeInTheDocument();
	});

	it("marks an absent `finally` as not configured", () => {
		renderEditor({ try: [{ id: "a" }], catch: [{ id: "b" }] });

		expect(screen.getByText(/finally: 0 steps \(not configured\)/)).toBeInTheDocument();
	});

	it("explains the fixed $.error / ctx.error semantics — there is no error-variable name to configure", () => {
		renderEditor({ try: [], catch: [] });

		expect(screen.getByText(/no error-variable name to set/i)).toBeInTheDocument();
		expect(screen.getAllByText("$.error").length).toBeGreaterThan(0);
	});

	it("calls onClose from the Close button", async () => {
		const user = userEvent.setup();
		const onClose = renderEditor({ try: [], catch: [] });

		await user.click(screen.getByRole("button", { name: /close/i }));

		expect(onClose).toHaveBeenCalled();
	});
});
