import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_COLORS, STATUS_DOT_COLORS, STATUS_LABELS } from "@/lib/constants";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Scoped to the design-system directories ONLY. That is what makes this guard
// need no allowlist and no ratchet file: the ~1,373 legacy raw-neutral
// occurrences elsewhere in Studio are simply out of scope, and every file a
// downstream E1 task creates is in scope from its first commit.
const SCANNED = ["components/primitives", "components/catalog", "catalog"];

const RAW_NEUTRAL =
	/\b(?:bg|text|border|ring|divide|from|to|via|fill|stroke|placeholder|outline|shadow|accent|caret|decoration)-(?:zinc|gray|slate|neutral|stone)-\d{2,3}\b/;
const HEX = /#[0-9a-fA-F]{6}\b/;
const ARBITRARY_COLOR = /-\[(?:#|rgb|hsl|oklch|color-mix|var\(--color-)/;

function walk(dir: string): string[] {
	let out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out = out.concat(walk(full));
		else if (/\.tsx?$/.test(entry)) out.push(full);
	}
	return out;
}

const files = SCANNED.flatMap((dir) => walk(path.join(src, dir)));

describe("design-system token guard", () => {
	it("scans a non-empty set of files", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it.each(files.map((f) => [path.relative(src, f), f] as const))("%s uses tokens only", (_rel, file) => {
		// Lines are checked individually so the failure message names the offender.
		const offenders = readFileSync(file, "utf8")
			.split("\n")
			.map((line, i) => ({ line, n: i + 1 }))
			.filter(({ line }) => RAW_NEUTRAL.test(line) || HEX.test(line) || ARBITRARY_COLOR.test(line))
			.map(({ line, n }) => `${n}: ${line.trim()}`);
		expect(offenders).toEqual([]);
	});
});

describe("token layer", () => {
	const css = readFileSync(path.join(src, "app.css"), "utf8");

	it("declares every semantic token components are told to use", () => {
		const semantic = [
			"canvas",
			"raised",
			"overlay",
			"hover",
			"control",
			"ink-strong",
			"ink",
			"ink-dimmed",
			"ink-muted",
			"ink-faint",
			"line",
			"line-strong",
			"line-bright",
			"accent",
			"accent-hover",
			"on-accent",
			"focus-ring",
		];
		expect(semantic.filter((t) => !css.includes(`--color-${t}:`))).toEqual([]);
	});

	it("declares a status token for every member of the status union", () => {
		const statuses = Object.keys(STATUS_LABELS);
		expect(statuses.filter((s) => !css.includes(`--color-status-${s}:`))).toEqual([]);
	});

	it("declares every layer with @theme static", () => {
		// Layer 1 is only ever reached through `var()`, and JS chart code reads the
		// status colors the same way, so neither has a utility keeping it alive in
		// the class scan. `static` is the documented guarantee that they are emitted
		// anyway. (Measured no-op at tailwind 4.3.3 — this pins the intent, not a
		// current behaviour.)
		expect(css.match(/^@theme static\s*\{/gm)?.length).toBe(3);
		expect(css).not.toMatch(/^@theme\s*\{/m);
	});

	it("defines the .focus-ring utility", () => {
		expect(css).toMatch(/@utility focus-ring/);
	});

	it("routes status color through tokens, not raw Tailwind scales", () => {
		for (const value of [...Object.values(STATUS_COLORS), ...Object.values(STATUS_DOT_COLORS)]) {
			expect(value).not.toMatch(RAW_NEUTRAL);
			for (const cls of value.split(" ")) {
				expect(cls).toMatch(/^(?:bg|text)-status-/);
			}
		}
	});
});
