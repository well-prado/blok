import { EmptyState } from "@/components/primitives/EmptyState";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { describe, expect, it } from "vitest";

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
});
