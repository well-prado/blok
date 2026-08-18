import { EmptyState } from "@/components/primitives/EmptyState";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

describe("EmptyState", () => {
	it("renders its heading and description", () => {
		render(<EmptyState icon={<Inbox />} title="No runs yet" description="Trigger a workflow to see it here." />);
		expect(screen.getByRole("heading", { name: "No runs yet" })).toBeInTheDocument();
		expect(screen.getByText("Trigger a workflow to see it here.")).toBeInTheDocument();
	});

	it("renders the doc link as a real link opening in a new tab", () => {
		render(
			<EmptyState
				icon={<Inbox />}
				title="No runs yet"
				description="…"
				docLink={{ href: "https://blok.dev/docs", label: "Read the docs" }}
			/>,
		);
		const link = screen.getByRole("link", { name: /Read the docs/ });
		expect(link).toHaveAttribute("href", "https://blok.dev/docs");
		expect(link).toHaveAttribute("target", "_blank");
	});

	it("copies a snippet and confirms it", async () => {
		const user = userEvent.setup();
		render(
			<EmptyState
				icon={<Inbox />}
				title="No runs yet"
				description="…"
				snippets={[{ lang: "curl · http", code: "curl -X POST /orders" }]}
			/>,
		);
		expect(screen.getByText("curl -X POST /orders")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "copy" }));
		expect(await screen.findByRole("button", { name: "copied" })).toBeInTheDocument();
		expect(await navigator.clipboard.readText()).toBe("curl -X POST /orders");
	});

	it("surfaces a copy failure instead of swallowing it", async () => {
		// The whole reason Snippet was rewired onto `useCopy`: its previous private
		// state machine was a bare boolean with a silent `catch {}`, so a rejected
		// clipboard write looked identical to a successful one. The success path
		// above passed against that broken version too — only this asserts the
		// difference.
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));

		render(
			<EmptyState
				icon={<Inbox />}
				title="No runs yet"
				description="…"
				snippets={[{ lang: "curl · http", code: "curl -X POST /orders" }]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "copy" }));
		expect(await screen.findByRole("button", { name: "copy failed" })).toBeInTheDocument();
		// The announcement, not just the label — a screen-reader user gets nothing
		// from a button caption they never hear.
		expect(screen.getByRole("status")).toHaveTextContent(/copy failed/i);

		writeText.mockRestore();
	});
});
