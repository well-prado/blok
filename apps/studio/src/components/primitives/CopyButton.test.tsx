import { CopyButton } from "@/components/primitives/CopyButton";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom has no clipboard at all, which is also what an insecure-context browser
// looks like — so both the success and the failure path are stubs here.
// NOTE: `userEvent.setup()` installs its OWN clipboard stub, so ours has to be
// installed after it or the component writes into user-event's stub instead.
function setClipboard(clipboard: { writeText: (value: string) => Promise<void> } | undefined) {
	Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

afterEach(() => {
	vi.useRealTimers();
	setClipboard(undefined);
});

describe("CopyButton", () => {
	it("writes the value and announces the copy", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard({ writeText });

		render(<CopyButton value="run_d1f7dca7" />);
		await user.click(screen.getByRole("button", { name: "Copy" }));

		expect(writeText).toHaveBeenCalledWith("run_d1f7dca7");
		expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
	});

	it("returns to idle after the copied window", async () => {
		vi.useFakeTimers();
		setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });

		render(<CopyButton value="run_d1f7dca7" />);
		// fireEvent, not userEvent: userEvent's own timer wiring fights fake timers,
		// and a plain click needs none of what userEvent adds.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		});
		expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");

		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(screen.getByRole("status")).toHaveTextContent("");
	});

	it("announces a failure when the clipboard rejects", async () => {
		const user = userEvent.setup();
		setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });

		render(<CopyButton value="run_d1f7dca7" />);
		await user.click(screen.getByRole("button", { name: "Copy" }));

		expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
	});

	it("announces a failure when there is no clipboard API (insecure context)", async () => {
		const user = userEvent.setup();
		setClipboard(undefined);

		render(<CopyButton value="run_d1f7dca7" />);
		await user.click(screen.getByRole("button", { name: "Copy" }));

		expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
	});

	it("does not copy when disabled", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard({ writeText });

		render(
			<CopyButton value="run_d1f7dca7" disabled>
				Copy id
			</CopyButton>,
		);
		await user.click(screen.getByRole("button", { name: "Copy id" }));

		expect(writeText).not.toHaveBeenCalled();
		expect(screen.getByRole("status")).toHaveTextContent("");
	});
});
