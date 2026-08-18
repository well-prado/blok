import { Input } from "@/components/primitives/Input";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("Input", () => {
	it("is reachable by its associated label", () => {
		render(
			<>
				<label htmlFor="email">Email</label>
				<Input id="email" />
			</>,
		);
		expect(screen.getByLabelText("Email")).toBeInTheDocument();
	});

	it("exposes its error text through aria-describedby while marked invalid", () => {
		render(
			<>
				<Input aria-label="Email" aria-invalid="true" aria-describedby="email-error" />
				<p id="email-error">Not a valid address</p>
			</>,
		);
		const input = screen.getByRole("textbox", { name: "Email" });
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(input).toHaveAccessibleDescription("Not a valid address");
	});

	it("accepts no input when disabled", async () => {
		render(<Input aria-label="Email" disabled />);
		await userEvent.type(screen.getByRole("textbox", { name: "Email" }), "hello");
		expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("");
	});
});
