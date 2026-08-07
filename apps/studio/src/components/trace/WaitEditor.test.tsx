import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type RawWait, WaitEditor } from "./WaitEditor";

function renderEditor(wait: RawWait, onSave = vi.fn()) {
	render(<WaitEditor stepId="pause" wait={wait} pending={false} onSave={onSave} onClose={vi.fn()} />);
	return onSave;
}

describe("WaitEditor — for (relative duration)", () => {
	it("opens in `for` mode by default and saves an edited duration string", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ for: "30s" });

		expect(screen.getByLabelText("for")).toHaveValue("30s");

		const input = screen.getByLabelText("for");
		await user.clear(input);
		await user.type(input, "5m");
		await user.click(screen.getByRole("button", { name: /save wait/i }));

		expect(onSave).toHaveBeenCalledWith({ for: "5m" });
	});

	it("stores a plain-integer `for` value as a number (milliseconds)", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({});

		await user.type(screen.getByLabelText("for"), "1500");
		await user.click(screen.getByRole("button", { name: /save wait/i }));

		expect(onSave).toHaveBeenCalledWith({ for: 1500 });
	});

	it("blocks save on an invalid duration instead of writing it silently", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({});

		await user.type(screen.getByLabelText("for"), "1.5h");
		await user.click(screen.getByRole("button", { name: /save wait/i }));

		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/enter a non-negative integer/i)).toBeInTheDocument();
	});

	it("previews the resolved fire time for a valid duration", async () => {
		const user = userEvent.setup();
		renderEditor({});

		await user.type(screen.getByLabelText("for"), "30s");

		expect(screen.getByText(/fires ≈/)).toBeInTheDocument();
	});
});

describe("WaitEditor — until (absolute deadline)", () => {
	it("opens in `until` mode when the incoming wait only sets `until`, and saves the string verbatim", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ until: "2026-01-01T00:00:00Z" });

		expect(screen.getByLabelText("until")).toHaveValue("2026-01-01T00:00:00Z");

		await user.click(screen.getByRole("button", { name: /save wait/i }));

		expect(onSave).toHaveBeenCalledWith({ until: "2026-01-01T00:00:00Z" });
	});

	it("stores a plain-integer `until` value as a number (ms since epoch)", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({});

		await user.click(screen.getByRole("button", { name: /until \(absolute\)/i }));
		await user.type(screen.getByLabelText("until"), "1735689600000");
		await user.click(screen.getByRole("button", { name: /save wait/i }));

		expect(onSave).toHaveBeenCalledWith({ until: 1735689600000 });
	});

	it("blocks save on an unparseable `until` instead of writing it silently", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({});

		await user.click(screen.getByRole("button", { name: /until \(absolute\)/i }));
		await user.type(screen.getByLabelText("until"), "not-a-date");
		await user.click(screen.getByRole("button", { name: /save wait/i }));

		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/enter ms-since-epoch/i)).toBeInTheDocument();
	});
});

describe("WaitEditor — for/until are mutually exclusive", () => {
	it("only ever saves one of `for` or `until`", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor({ for: "10s" });

		await user.click(screen.getByRole("button", { name: /until \(absolute\)/i }));
		await user.type(screen.getByLabelText("until"), "2026-06-01T00:00:00Z");
		await user.click(screen.getByRole("button", { name: /save wait/i }));

		const saved = onSave.mock.calls[0]?.[0];
		expect(saved).toEqual({ until: "2026-06-01T00:00:00Z" });
		expect(saved).not.toHaveProperty("for");
	});
});
