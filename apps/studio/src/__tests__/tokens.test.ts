import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_COLORS, STATUS_DOT_COLORS, STATUS_LABELS } from "@/lib/constants";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(src, "app.css"), "utf8");

// Scoped to the design-system directories ONLY. That is what makes this guard
// need no allowlist and no ratchet file: the ~1,373 legacy raw-neutral
// occurrences elsewhere in Studio are simply out of scope, and every file a
// downstream E1 task creates is in scope from its first commit.
const SCANNED = ["components/primitives", "components/catalog", "catalog"];

const UTILITY_PREFIXES =
	"bg|text|border|ring|divide|from|to|via|fill|stroke|placeholder|outline|shadow|accent|caret|decoration";

// EVERY Tailwind hue, not just the neutrals. A pasted `text-red-500` renders
// (wrong color, unreachable by light mode); the neutrals-only version of this
// regex passed a probe containing four raw non-neutral colors.
const TAILWIND_HUES =
	"zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const RAW_COLOR = new RegExp(`\\b(?:${UTILITY_PREFIXES})-(?:${TAILWIND_HUES})-\\d{2,3}\\b`);
const HEX = /#[0-9a-fA-F]{6}\b/;
// The one reference-dialect class that carries no color prefix, so the
// undeclared-token check below cannot see it. Studio's is `.focus-ring`.
const REFERENCE_DIALECT = /\bfocus-custom\b/;
const ARBITRARY_COLOR = /-\[(?:#|rgb|hsl|oklch|oklab|color-mix|var\(--color-)/;

// The token vocabulary, DERIVED FROM app.css so the guard cannot drift from the
// tokens. Layer 1 is declared but banned in components (CONVENTIONS §10): a raw
// ramp reference is a pixel light mode can never re-map, same as a hex.
const declared = new Set([...css.matchAll(/--color-([A-Za-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
const LAYER_1 = /^(?:graphite|blok-green)-/;
const TOKENS = new Set([...declared].filter((t) => !LAYER_1.test(t)));

// Non-color utilities that share the `text-`/`bg-`/`border-` prefixes. Anything
// not here and not a declared token is a name Tailwind emits NOTHING for.
const KEYWORDS: Record<string, RegExp> = {
	text: /^(?:xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|current|transparent|inherit|align|decoration|transform|overflow|shadow|indent|size|color)$/,
	bg: /^(?:none|transparent|current|inherit|fixed|local|scroll|auto|cover|contain|center|top|bottom|left|right|repeat|no-repeat|color|image|(?:gradient|linear|radial|conic|clip|origin|blend|size|position|repeat)-.*)$/,
	border:
		/^(?:\d+(?:\.\d+)?|none|solid|dashed|dotted|double|hidden|collapse|separate|current|transparent|inherit|radius|color|width|style|spacing|image|[trblxyse])$/,
};
const BORDER_SIDE = /^(?:[trblxyse]|inline-start|inline-end|block-start|block-end)-/;

/** Utility class names using a color-capable prefix, with their resolved token name. */
function unknownTokens(line: string): string[] {
	const out: string[] = [];
	for (const m of line.matchAll(/\b(text|bg|border)-([A-Za-z0-9][\w.\/[\]#%()-]*)/g)) {
		const prefix = m[1] as string;
		let rest = (m[2] as string).split("/")[0] as string; // drop the /10 opacity modifier
		if (prefix === "border") rest = rest.replace(BORDER_SIDE, ""); // border-l-[3px] → [3px]
		// Arbitrary values are ARBITRARY_COLOR's job; a non-color one (`border-l-[3px]`) is fine.
		if (rest === "" || rest.startsWith("[") || TOKENS.has(rest) || KEYWORDS[prefix]?.test(rest)) continue;
		out.push(`${prefix}-${rest}`);
	}
	return out;
}

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

	it("knows the token vocabulary it is enforcing", () => {
		// If app.css parsing ever silently yields nothing, the unknown-token check
		// would flag every token in the codebase (or, worse, a typo'd regex would
		// flag none). Pin both ends.
		expect(TOKENS.has("ink-muted")).toBe(true);
		expect(TOKENS.has("status-timedOut-ink")).toBe(true);
		expect(TOKENS.has("graphite-500")).toBe(false);
	});

	it.each(files.map((f) => [path.relative(src, f), f] as const))("%s uses tokens only", (_rel, file) => {
		// Lines are checked individually so the failure message names the offender.
		const offenders = readFileSync(file, "utf8")
			.split("\n")
			.map((line, i) => ({ line, n: i + 1 }))
			.flatMap(({ line, n }) => {
				const why: string[] = [];
				if (RAW_COLOR.test(line)) why.push("raw Tailwind color");
				if (HEX.test(line)) why.push("hex literal");
				if (ARBITRARY_COLOR.test(line)) why.push("arbitrary color value");
				if (REFERENCE_DIALECT.test(line)) why.push("trigger.dev class name (use .focus-ring)");
				const unknown = unknownTokens(line);
				if (unknown.length > 0) why.push(`undeclared token: ${unknown.join(", ")}`);
				return why.length > 0 ? [`${n}: [${why.join("; ")}] ${line.trim()}`] : [];
			});
		expect(offenders).toEqual([]);
	});
});

describe("token layer", () => {
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

	it("declares a fill AND a text token for every member of the status union", () => {
		const statuses = Object.keys(STATUS_LABELS);
		expect(statuses.filter((s) => !css.includes(`--color-status-${s}:`))).toEqual([]);
		expect(statuses.filter((s) => !css.includes(`--color-status-${s}-ink:`))).toEqual([]);
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

	it("routes status color through status tokens, not raw Tailwind scales", () => {
		// Deliberately NOT pinned to the fill token: text and fill are separate
		// roles (app.css layer 3), and an assertion that forces `text-status-X`
		// onto the fill value is what locked the contrast regression in.
		for (const [status, value] of Object.entries(STATUS_COLORS)) {
			expect(value).not.toMatch(RAW_COLOR);
			for (const cls of value.split(" ")) {
				expect(cls).toMatch(new RegExp(`^(?:bg|text)-status-${status}(?:-ink)?(?:/\\d+)?$`));
				expect(TOKENS.has(cls.replace(/^(?:bg|text)-/, "").split("/")[0] as string)).toBe(true);
			}
		}
		for (const value of Object.values(STATUS_DOT_COLORS)) {
			expect(value).not.toMatch(RAW_COLOR);
			expect(value).toMatch(/^bg-status-/);
		}
	});
});

// ── Contrast ────────────────────────────────────────────────────────────────
// The chip regression this guard exists to prevent was invisible to every other
// check: types, lint, build and 440 tests all passed while three chips crossed
// below WCAG AA. Ratios are computed from app.css itself, so retuning a token
// re-runs the math.

function hex(h: string): [number, number, number] {
	return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
	const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}
/** `bg-X/10` over `bg`, the way the browser composites it. */
function wash(fg: string, alpha: number, bg: string): string {
	const [f, b] = [hex(fg), hex(bg)];
	return `#${f
		.map((c, i) =>
			Math.round(c * alpha + (b[i] as number) * (1 - alpha))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}
/** Resolve a layer-2/3 token to a literal hex, following one `var()` hop. */
function resolve(token: string): string {
	const direct = css.match(new RegExp(`--color-${token}:\\s*([^;]+);`))?.[1]?.trim();
	if (!direct) throw new Error(`no --color-${token} in app.css`);
	const hop = direct.match(/var\(--color-([A-Za-z0-9-]+)\)/);
	return hop ? resolve(hop[1] as string) : direct;
}

describe("contrast", () => {
	const SURFACES = ["canvas", "raised", "overlay", "hover", "control"];

	it.each(Object.keys(STATUS_LABELS))("chip %s is legible on bg-raised", (status) => {
		// StatusBadge is text-xs/font-medium = 12px/500 = normal text, so AA is 4.5.
		const chip = wash(resolve(`status-${status}`), 0.1, resolve("raised"));
		expect(ratio(resolve(`status-${status}-ink`), chip)).toBeGreaterThanOrEqual(4.5);
	});

	it("every text ink clears AA on every surface", () => {
		const failures = [];
		for (const ink of ["ink-strong", "ink", "ink-dimmed", "ink-muted"]) {
			for (const surface of SURFACES) {
				const r = ratio(resolve(ink), resolve(surface));
				if (r < 4.5) failures.push(`${ink} on ${surface}: ${r.toFixed(2)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("ink-faint clears the 3:1 non-text threshold (it is not a text ink)", () => {
		const failures = SURFACES.map((s) => [s, ratio(resolve("ink-faint"), resolve(s))] as const)
			.filter(([, r]) => r < 3)
			.map(([s, r]) => `${s}: ${r.toFixed(2)}`);
		expect(failures).toEqual([]);
	});
});
