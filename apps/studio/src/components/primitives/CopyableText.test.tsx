import { CopyableText } from "@/components/primitives/CopyableText";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Installed AFTER `userEvent.setup()`, which stubs `navigator.clipboard` itself.
function setClipboard(clipboard: { writeText: (value: string) => Promise<void> } | undefined) {
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

afterEach(() => setClipboard(undefined));

describe("CopyableText", () => {
	it("names itself after the text it copies", () => {
		render(<CopyableText value="run_d1f7dca7" />);
		expect(screen.getByRole("button", { name: "Copy run_d1f7dca7" })).toHaveTextContent("run_d1f7dca7");
	});

	it("copies copyValue when it differs from the displayed text", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard({ writeText });

		render(<CopyableText value="run_d1f7…dca7" copyValue="run_d1f7dca71dbe" />);
		await user.click(screen.getByRole("button", { name: /^Copy run_/ }));

		expect(writeText).toHaveBeenCalledWith("run_d1f7dca71dbe");
		expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
	});

	it("is operable from the keyboard", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard({ writeText });

		render(<CopyableText value="run_d1f7dca7" />);
		await user.tab();
		expect(screen.getByRole("button", { name: "Copy run_d1f7dca7" })).toHaveFocus();
		await user.keyboard("{Enter}");

		expect(writeText).toHaveBeenCalledWith("run_d1f7dca7");
	});
});
