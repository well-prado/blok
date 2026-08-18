import { FormButtons } from "@/components/primitives/FormButtons";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("FormButtons", () => {
	it("submits the form from its confirm slot", async () => {
		const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
		render(
			<form onSubmit={onSubmit}>
				<FormButtons
					cancelButton={<button type="button">Cancel</button>}
					confirmButton={<button type="submit">Save</button>}
				/>
			</form>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(onSubmit).toHaveBeenCalledOnce();
	});

	it("keeps the confirm slot right-aligned when there is no cancel button", () => {
		render(<FormButtons confirmButton={<button type="submit">Save</button>} />);
		expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
	});
});
