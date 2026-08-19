import { EnvironmentSelector } from "@/components/shared/EnvironmentSelector";
import { useEnvScope } from "@/stores/envScope";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

beforeEach(() => {
	useEnvScope.setState({
		current: "production",
		available: [
			{ id: "production", name: "production", description: "live deployments" },
			{ id: "staging", name: "staging", description: "pre-prod" },
		],
	});
});

test("renders current environment", () => {
	render(<EnvironmentSelector />);
	expect(screen.getByRole("button", { name: "Environment: production" })).toBeInTheDocument();
	expect(screen.getByText("production")).toBeInTheDocument();
});

test("opens dropdown and selects an environment", async () => {
	const user = userEvent.setup();
	render(<EnvironmentSelector />);

	const trigger = screen.getByRole("button", { name: "Environment: production" });
	await user.click(trigger);

	const stagingOption = screen.getByRole("menuitemradio", { name: /staging/i });
	expect(stagingOption).toBeInTheDocument();

	await user.click(stagingOption);

	expect(useEnvScope.getState().current).toBe("staging");
});
