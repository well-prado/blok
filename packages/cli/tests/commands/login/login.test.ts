import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { login } from "../../../src/commands/login";
import { tokenManager } from "../../../src/services/local-token-manager";

/**
 * `login` cannot be awaited against the real world: it fetches BLOK_URL and,
 * on any failure, calls `process.exit(1)` — which tears down the vitest worker
 * mid-run instead of failing a test. It also persists to the developer's real
 * ~/.blok/token/token.enc. So stub the verification request and restore the
 * caller's token afterwards, then assert the outcome that matters: a verified
 * token is stored.
 */
let savedToken: string | null = null;

beforeEach(() => {
	savedToken = tokenManager.getToken();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ active: true }), { status: 200 })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (savedToken) {
		tokenManager.storeToken(savedToken);
	} else {
		tokenManager.clearToken();
	}
});

test("login", async () => {
	await login({ token: "test" });

	expect(tokenManager.getToken()).toBe("test");
});
