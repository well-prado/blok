/**
 * `blokctl check` — the secrets a project's installed packages REQUIRE (#1018).
 *
 * The issue asks for "`blokctl check` fails fast on a missing secret". Both
 * secrets involved have no default and cannot get one: a constant flash secret
 * lets anyone forge a flash message, and a constant session secret lets anyone
 * forge a session cookie, i.e. sign in as any user. Without this check the
 * first sign of a missing one is a 500 on the first request in production.
 *
 * The check is driven by what is INSTALLED, so a project that never added the
 * SPA or the auth kit is never asked for either.
 */

import path from "node:path";
import fsExtra from "fs-extra";

/** Shortest secret the packages accept — `resolveSessionSecret`'s floor. */
const MIN_SECRET_LENGTH = 16;

export interface SecretRequirement {
	/** Env var name. */
	name: string;
	/** The package that requires it. */
	from: string;
	/** What it signs, for the failure message. */
	what: string;
}

export interface SecretCheck extends SecretRequirement {
	status: "ok" | "missing" | "too-short";
	/** Never the value — just how long it is, so a log is safe to paste. */
	length: number;
}

/** Every dependency name in a project manifest. */
function dependencyNames(projectDir: string): Set<string> {
	const manifestPath = path.join(projectDir, "package.json");
	if (!fsExtra.existsSync(manifestPath)) return new Set();
	try {
		const manifest = fsExtra.readJsonSync(manifestPath) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		return new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
	} catch {
		return new Set();
	}
}

/**
 * Parse `KEY=value` lines out of a dotenv file. Deliberately tiny: this only
 * has to answer "is it set, and is it long enough", never to evaluate anything.
 */
function readEnvFile(file: string): Record<string, string> {
	if (!fsExtra.existsSync(file)) return {};
	const out: Record<string, string> = {};
	for (const line of fsExtra.readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		out[trimmed.slice(0, eq).trim()] = trimmed
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return out;
}

/** Which secrets this project's dependencies require. */
export function requiredSecrets(projectDir: string): SecretRequirement[] {
	const deps = dependencyNames(projectDir);
	const required: SecretRequirement[] = [];
	if (deps.has("@blokjs/inertia") || deps.has("@blokjs/session")) {
		required.push({
			name: "BLOK_FLASH_SECRET",
			from: deps.has("@blokjs/inertia") ? "@blokjs/inertia" : "@blokjs/session",
			what: "the one-shot flash cookie (validation errors, toasts)",
		});
	}
	if (deps.has("@blokjs/session")) {
		required.push({
			name: "BLOK_SESSION_SECRET",
			from: "@blokjs/session",
			what: "the session cookie — a forgeable one means signing in as any user",
		});
	}
	return required;
}

/**
 * Check each required secret against `process.env`, then `.env.local`, then
 * `.env`. `.env.example` is deliberately NOT consulted: it ships blank.
 */
export function checkSecrets(projectDir: string, env: NodeJS.ProcessEnv = process.env): SecretCheck[] {
	const fromFiles = {
		...readEnvFile(path.join(projectDir, ".env")),
		...readEnvFile(path.join(projectDir, ".env.local")),
	};
	return requiredSecrets(projectDir).map((requirement) => {
		const value = env[requirement.name] ?? fromFiles[requirement.name] ?? "";
		const status = value === "" ? "missing" : value.length < MIN_SECRET_LENGTH ? "too-short" : "ok";
		return { ...requirement, status, length: value.length };
	});
}

/** One human line per secret, with the fix. */
export function formatSecretReport(checks: readonly SecretCheck[]): string[] {
	return checks.map((check) => {
		if (check.status === "ok") return `    ✓ ${check.name}  set (${check.from})`;
		if (check.status === "too-short") {
			return `    ✗ ${check.name}  only ${check.length} characters — ${check.from} needs at least ${MIN_SECRET_LENGTH}.\n      Fix: ${check.name}=$(openssl rand -base64 32) in .env.local`;
		}
		return `    ✗ ${check.name}  NOT SET — signs ${check.what}.\n      Fix: ${check.name}=$(openssl rand -base64 32) in .env.local`;
	});
}
