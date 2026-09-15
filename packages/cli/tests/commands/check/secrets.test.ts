/**
 * `blokctl check` — the secrets gate (#1018 security review M3).
 *
 * The issue's line is "`blokctl check` fails fast on a missing secret". Neither
 * secret has a default and neither can get one, so "fails fast" has to mean
 * BEFORE the first request, not a 500 in production.
 */
import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSecrets, formatSecretReport, requiredSecrets } from "../../../src/commands/check/secrets.js";

let dir: string;

/** A project manifest with the given dependencies. */
function project(dependencies: Record<string, string>, env: Record<string, string> = {}): void {
	fsExtra.writeJsonSync(path.join(dir, "package.json"), { name: "app", dependencies });
	const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
	if (lines.length > 0) fsExtra.writeFileSync(path.join(dir, ".env.local"), `${lines.join("\n")}\n`);
}

const LONG = "0".repeat(64);

beforeEach(() => {
	dir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-check-secrets-"));
});

afterEach(() => {
	fsExtra.removeSync(dir);
});

describe("blokctl check — required secrets", () => {
	it("asks for nothing in a project that installed neither package", () => {
		project({ "@blokjs/runner": "^2.3.0" });
		expect(requiredSecrets(dir)).toEqual([]);
		expect(checkSecrets(dir, {})).toEqual([]);
	});

	it("asks for the flash secret once the SPA is installed", () => {
		project({ "@blokjs/inertia": "^2.3.0" });
		expect(requiredSecrets(dir).map((s) => s.name)).toEqual(["BLOK_FLASH_SECRET"]);
	});

	it("asks for BOTH once the auth kit is installed", () => {
		project({ "@blokjs/inertia": "^2.3.0", "@blokjs/session": "^2.3.0", "@blokjs/auth": "^2.3.0" });
		expect(requiredSecrets(dir).map((s) => s.name)).toEqual(["BLOK_FLASH_SECRET", "BLOK_SESSION_SECRET"]);
	});

	it("fails a kit project with no session secret, and names the fix", () => {
		project({ "@blokjs/inertia": "^2.3.0", "@blokjs/session": "^2.3.0" }, { BLOK_FLASH_SECRET: LONG });
		const checks = checkSecrets(dir, {});
		expect(checks.find((c) => c.name === "BLOK_SESSION_SECRET")?.status).toBe("missing");
		expect(checks.find((c) => c.name === "BLOK_FLASH_SECRET")?.status).toBe("ok");

		const report = formatSecretReport(checks).join("\n");
		expect(report).toContain("BLOK_SESSION_SECRET");
		expect(report).toContain("Fix:");
		// The message must never carry the value of a secret that IS set.
		expect(report).not.toContain(LONG);
	});

	it("fails a secret too short to be an HMAC key", () => {
		project({ "@blokjs/session": "^2.3.0" }, { BLOK_FLASH_SECRET: LONG, BLOK_SESSION_SECRET: "short" });
		expect(checkSecrets(dir, {}).find((c) => c.name === "BLOK_SESSION_SECRET")?.status).toBe("too-short");
	});

	it("reads .env.local, and the process environment wins over it", () => {
		project({ "@blokjs/session": "^2.3.0" }, { BLOK_FLASH_SECRET: LONG, BLOK_SESSION_SECRET: "short" });
		const checks = checkSecrets(dir, { BLOK_SESSION_SECRET: LONG });
		expect(checks.every((c) => c.status === "ok")).toBe(true);
	});

	/** `.env.example` ships the KEYS with no values — it must never satisfy the check. */
	it("does not accept .env.example as proof", () => {
		project({ "@blokjs/session": "^2.3.0" });
		fsExtra.writeFileSync(path.join(dir, ".env.example"), "BLOK_SESSION_SECRET=\nBLOK_FLASH_SECRET=\n");
		expect(checkSecrets(dir, {}).every((c) => c.status === "missing")).toBe(true);
	});

	it("passes a fully configured kit project", () => {
		project(
			{ "@blokjs/inertia": "^2.3.0", "@blokjs/session": "^2.3.0" },
			{ BLOK_FLASH_SECRET: LONG, BLOK_SESSION_SECRET: LONG },
		);
		expect(checkSecrets(dir, {}).every((c) => c.status === "ok")).toBe(true);
	});
});
