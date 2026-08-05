import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import LoginFixtureUI from "../../src/nodes/examples/login-fixture-ui";

const ctx = {} as Context;
const run = async (input: { page: "login" | "dashboard"; email?: string; authed?: boolean }) => {
	const response = (await LoginFixtureUI.handle(ctx, input)) as { data: unknown };
	return response.data as string;
};

describe("login-fixture-ui", () => {
	it("renders the login form posting to the dashboard", async () => {
		const html = await run({ page: "login" });
		expect(html).toContain('action="/fixtures/dashboard"');
		expect(html).toContain('type="password"');
		expect(html).toContain(">Sign in</button>");
	});

	it("renders the welcome header for an authed dashboard", async () => {
		const html = await run({ page: "dashboard", email: "alice@example.com", authed: true });
		expect(html).toContain('data-testid="welcome"');
		expect(html).toContain("Welcome, alice@example.com");
	});

	it("renders invalid credentials without a welcome header when unauthed", async () => {
		const html = await run({ page: "dashboard", email: "alice@example.com", authed: false });
		expect(html).toContain("Invalid credentials");
		expect(html).not.toContain('data-testid="welcome"');
	});

	it("escapes HTML in the echoed email", async () => {
		const html = await run({ page: "dashboard", email: "<img src=x>", authed: true });
		expect(html).not.toContain("<img src=x>");
		expect(html).toContain("&lt;img src=x&gt;");
	});
});
