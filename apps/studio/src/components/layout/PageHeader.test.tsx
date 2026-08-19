import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageAccessories } from "./PageAccessories";
import { PageHeader } from "./PageHeader";
import { PageTitle } from "./PageTitle";

describe("PageHeader Components", () => {
	it("renders PageHeader with children", () => {
		render(
			<PageHeader data-testid="header">
				<span>Header Content</span>
			</PageHeader>,
		);
		const header = screen.getByTestId("header");
		expect(header).toBeInTheDocument();
		expect(header).toHaveTextContent("Header Content");
	});

	it("renders PageTitle with correct styles", () => {
		render(<PageTitle>My Title</PageTitle>);
		const title = screen.getByText("My Title");
		expect(title.tagName).toBe("H1");
		expect(title).toHaveClass("text-2xl", "font-medium", "font-display");
	});

	it("renders PageAccessories with children", () => {
		render(
			<PageAccessories data-testid="accessories">
				<button type="button">Action</button>
			</PageAccessories>,
		);
		const accessories = screen.getByTestId("accessories");
		expect(accessories).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
	});

	it("applies custom classes to all components", () => {
		render(
			<PageHeader className="custom-header">
				<PageTitle className="custom-title">Title</PageTitle>
				<PageAccessories className="custom-acc">Actions</PageAccessories>
			</PageHeader>,
		);

		expect(screen.getByText("Title").parentElement).toHaveClass("custom-header");
		expect(screen.getByText("Title")).toHaveClass("custom-title");
		expect(screen.getByText("Actions")).toHaveClass("custom-acc");
	});
});
