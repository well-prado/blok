import { ClipboardField } from "@/components/primitives/ClipboardField";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

function setClipboard(clipboard: { writeText: (value: string) => Promise<void> } | undefined) {
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

afterEach(() => setClipboard(undefined));

describe("ClipboardField", () => {
	it("exposes the value as a named read-only field", () => {
		render(<ClipboardField value="blok_sk_123" label="API key" />);
		const field = screen.getByRole("textbox", { name: "API key" });
		expect(field).toHaveValue("blok_sk_123");
		expect(field).toHaveAttribute("readonly");
	});

	it("selects the whole value on focus, so it is copyable without the clipboard API", async () => {
		const user = userEvent.setup();
		render(<ClipboardField value="blok_sk_123" />);
		const field = screen.getByRole("textbox") as HTMLInputElement;

		await user.click(field);

		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe("blok_sk_123".length);
	});

	it("copies the value from its copy button", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard({ writeText });

		render(<ClipboardField value="blok_sk_123" />);
		await user.click(screen.getByRole("button", { name: "Copy" }));

		expect(writeText).toHaveBeenCalledWith("blok_sk_123");
	});
});
