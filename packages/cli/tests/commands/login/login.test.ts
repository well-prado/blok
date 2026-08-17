import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { login } from "../../../src/commands/login";
import { tokenManager } from "../../../src/services/local-token-manager";

/**
 * `login` cannot be run against the real world: it fetches BLOK_URL and it
 * persists to the developer's real ~/.blok/token/token.enc. So stub the
 * verification request and restore the caller's token afterwards, then assert
 * the outcomes that matter: a verified token is stored (#892), and a failed
 * one REJECTS — `login()` used to call `process.exit(1)` from its own catch
 * block, which tore down any host that imports it (a vitest worker, a
 * programmatic caller, Studio embedding) with no chance to recover (#891).
 *
 * Since #899 it does not touch `process.exitCode` either: setting the exit
 * status is the command error boundary's job (withErrorBoundary in
 * services/commander.ts), so `login()` is inert for a programmatic caller that
 * catches the rejection.
 */
let savedToken: string | null = null;
const originalExitCode = process.exitCode;
const originalNonInteractiveEnv = process.env.BLOK_NON_INTERACTIVE;
const originalTokenEnv = process.env.BLOKS_TOKEN;

function restoreEnv(key: "BLOK_NON_INTERACTIVE" | "BLOKS_TOKEN", value: string | undefined) {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, key);
	} else {
		process.env[key] = value;
	}
}

beforeEach(() => {
	savedToken = tokenManager.getToken();
	process.exitCode = undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ active: true }), { status: 200 })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	process.exitCode = originalExitCode;
	restoreEnv("BLOK_NON_INTERACTIVE", originalNonInteractiveEnv);
	restoreEnv("BLOKS_TOKEN", originalTokenEnv);
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

// Regression tests for #891: login() must reject and let the caller decide,
// never force the process down.
test("login rejects on a failed token instead of killing the process", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, statusText: "Unauthorized" })) as unknown as typeof fetch);
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("process.exit must not be called from login()");
	});

	await expect(login({ token: "bad-token" })).rejects.toThrow("Unauthorized");

	expect(exitSpy).not.toHaveBeenCalled();
	// And it leaves the host's exit status ALONE — the boundary sets it from
	// the rejection, so catching the error here has no side effect.
	expect(process.exitCode).toBeUndefined();
});

test("login rejects when no token can be resolved in non-interactive mode", async () => {
	vi.spyOn(tokenManager, "getToken").mockReturnValue(null);
	process.env.BLOK_NON_INTERACTIVE = "1";
	Reflect.deleteProperty(process.env, "BLOKS_TOKEN");
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("process.exit must not be called from login()");
	});

	await expect(login({})).rejects.toThrow(/non-interactive mode/);

	expect(exitSpy).not.toHaveBeenCalled();
	expect(process.exitCode).toBeUndefined();
});
