import { afterEach, beforeEach, expect, test } from "vitest";
import { logout } from "../../../src/commands/logout";
import { tokenManager } from "../../../src/services/local-token-manager";

/**
 * `logout` clears the real ~/.blok/token/token.enc, so save and restore the
 * developer's token around it instead of signing them out on every test run.
 */
let savedToken: string | null = null;

beforeEach(() => {
	savedToken = tokenManager.getToken();
	tokenManager.storeToken("test");
});

afterEach(() => {
	if (savedToken) {
		tokenManager.storeToken(savedToken);
	} else {
		tokenManager.clearToken();
	}
});

test("logout", async () => {
	await logout({ token: "test" });

	expect(tokenManager.getToken()).toBeNull();
});
