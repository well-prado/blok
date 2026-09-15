/**
 * Issue #1054 — the SPA design system is ONE system, not seven drifting copies.
 *
 * `blok.css`, `theme.ts` and `flash-toast.ts` are shipped by value (the SPA
 * templates are copied files, and the examples are not workspace packages, so
 * neither can import a shared package). This suite is what keeps "shipped by
 * value" from becoming "shipped seven different ways", and it checks that the
 * palette those files declare actually clears WCAG AA in both themes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every client the design system ships in: three templates, four examples. */
const CLIENT_SRC_DIRS = [
	"templates/spa-react/src",
	"templates/spa-vue/src",
	"templates/spa-svelte/src",
	"examples/inertia-react/client/src",
	"examples/inertia-vue/client/src",
	"examples/inertia-svelte/client/src",
	"examples/inertia-standalone/frontend/src",
];

/** The auth kit's client half (#1018) — react, vue, svelte, in that order. */
const KIT_DIRS = [
	"templates/spa-react/kits/auth/src",
	"templates/spa-vue/kits/auth/src",
	"templates/spa-svelte/kits/auth/src",
];

/** The client entry of each of those, in the same order. */
const ENTRIES = [
	"templates/spa-react/src/app.tsx",
	"templates/spa-vue/src/app.ts",
	"templates/spa-svelte/src/app.ts",
	"examples/inertia-react/client/src/main.tsx",
	"examples/inertia-vue/client/src/main.ts",
	"examples/inertia-svelte/client/src/main.ts",
	"examples/inertia-standalone/frontend/src/main.tsx",
];

/** Brand green (`docs/assets/logo/mark.svg`, `apps/studio/src/app.css`). */
const BRAND_GREEN = "#2bcd71";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

// =============================================================================
// One system, seven copies
// =============================================================================

function assertIdentical(relFiles: string[], label: string): void {
	const [first, ...rest] = relFiles;
	const reference = read(first);
	expect(reference.length, `${label}: ${first} is empty`).toBeGreaterThan(0);
	for (const rel of rest) {
		// Compared as text so a failure prints the drifting lines, not "Buffer".
		expect(read(rel), `${label}: ${rel} has drifted from ${first}`).toBe(reference);
	}
}

describe("the SPA design system ships as one system", () => {
	it("has the same blok.css bytes in all three templates and all four examples", () => {
		expect(CLIENT_SRC_DIRS).toHaveLength(7);
		assertIdentical(
			CLIENT_SRC_DIRS.map((dir) => `${dir}/styles/blok.css`),
			"blok.css",
		);
	});

	it("has the same theme.ts bytes everywhere", () => {
		assertIdentical(
			CLIENT_SRC_DIRS.map((dir) => `${dir}/styles/theme.ts`),
			"theme.ts",
		);
	});

	it("has the same flash-toast.ts bytes everywhere", () => {
		assertIdentical(
			CLIENT_SRC_DIRS.map((dir) => `${dir}/flash-toast.ts`),
			"flash-toast.ts",
		);
	});

	/**
	 * The logo is shipped by value too — it is the brand, so a hand edit in one
	 * client is exactly the drift this suite exists to stop.
	 */
	it("has the same BlokLogo bytes within each framework", () => {
		assertIdentical(
			[
				"templates/spa-react/src/components/BlokLogo.tsx",
				"examples/inertia-react/client/src/components/BlokLogo.tsx",
				"examples/inertia-standalone/frontend/src/components/BlokLogo.tsx",
			],
			"BlokLogo.tsx",
		);
		assertIdentical(
			["templates/spa-vue/src/components/BlokLogo.vue", "examples/inertia-vue/client/src/components/BlokLogo.vue"],
			"BlokLogo.vue",
		);
		assertIdentical(
			[
				"templates/spa-svelte/src/components/BlokLogo.svelte",
				"examples/inertia-svelte/client/src/components/BlokLogo.svelte",
			],
			"BlokLogo.svelte",
		);
	});

	it("has the same NavLinks bytes in both Vue clients", () => {
		assertIdentical(
			["templates/spa-vue/src/components/NavLinks.vue", "examples/inertia-vue/client/src/components/NavLinks.vue"],
			"NavLinks.vue",
		);
	});

	/**
	 * The 375px menu is a persistent `<details>`: an Inertia visit swaps the page
	 * underneath it and leaves it open over the new page unless a nav click
	 * closes it (#1054 review, H1).
	 */
	it("closes the compact menu on every nav click, in every framework", () => {
		const layouts = [
			"templates/spa-react/src/components/AppLayout.tsx",
			"examples/inertia-react/client/src/components/AppLayout.tsx",
			"examples/inertia-standalone/frontend/src/components/AppLayout.tsx",
			"templates/spa-vue/src/components/NavLinks.vue",
			"examples/inertia-vue/client/src/components/NavLinks.vue",
			"templates/spa-svelte/src/components/AppLayout.svelte",
			"examples/inertia-svelte/client/src/components/AppLayout.svelte",
		];
		for (const rel of layouts) {
			const source = read(rel);
			expect(source, `${rel} has no closeMenu handler`).toContain('closest("details")?.removeAttribute("open")');
			// Wired to BOTH the internal <Link> and the external <a>.
			const wired = source.match(/closeMenu/g) ?? [];
			expect(wired.length, `${rel} declares closeMenu but wires it to fewer than two links`).toBeGreaterThanOrEqual(3);
		}
	});

	/** The signed-in identity has nowhere else to go below 48rem. */
	it("shows the signed-in user inside the compact menu", () => {
		for (const rel of [
			"templates/spa-react/src/components/AppLayout.tsx",
			"examples/inertia-react/client/src/components/AppLayout.tsx",
			"examples/inertia-standalone/frontend/src/components/AppLayout.tsx",
			"templates/spa-vue/src/components/AppLayout.vue",
			"examples/inertia-vue/client/src/components/AppLayout.vue",
			"templates/spa-svelte/src/components/AppLayout.svelte",
			"examples/inertia-svelte/client/src/components/AppLayout.svelte",
		]) {
			expect(read(rel), `${rel} drops the user at phone width`).toContain("blok-menu__user");
		}
		expect(read(`${CLIENT_SRC_DIRS[0]}/styles/blok.css`)).toContain(".blok-menu__user {");
	});

	it("loads the stylesheet, the theme and the toast from every client entry", () => {
		for (const rel of ENTRIES) {
			const source = read(rel);
			expect(source, `${rel} does not import blok.css`).toContain('import "./styles/blok.css"');
			expect(source, `${rel} does not initialise the theme`).toContain("initTheme()");
			expect(source, `${rel} does not install the favicon`).toContain("installFavicon()");
			expect(source, `${rel} does not listen for flash`).toContain("listenForFlash()");
		}
	});

	it("paints Inertia's progress bar in the brand green everywhere", () => {
		for (const rel of ENTRIES) {
			expect(read(rel), `${rel} does not use the brand green for progress`).toContain(
				`progress: { color: "${BRAND_GREEN}" }`,
			);
		}
	});

	/**
	 * Titles are NOT uniform across frameworks, and pretending otherwise is what
	 * shipped dead config (#1054 review, H4): `@inertiajs/react|vue3` resolve the
	 * `title:` callback, but `@inertiajs/svelte` 3.7.1 has no `<Head>` and
	 * hard-codes its head manager's resolver to identity, so the option there
	 * never runs. Svelte pages build their own `<svelte:head>` title instead.
	 */
	it("suffixes page titles through the title callback in React and Vue", () => {
		for (const [rel, suffix] of [
			["templates/spa-react/src/app.tsx", "__BLOK_SPA_NAME__"],
			["templates/spa-vue/src/app.ts", "__BLOK_SPA_NAME__"],
			["examples/inertia-react/client/src/main.tsx", "Blok"],
			["examples/inertia-vue/client/src/main.ts", "Blok"],
			["examples/inertia-standalone/frontend/src/main.tsx", "Blok"],
		] as const) {
			const source = read(rel);
			expect(source, `${rel} has no title callback`).toMatch(/title:\s*\(title\)\s*=>/);
			expect(source, `${rel} does not suffix the title with ${suffix}`).toContain("${title}");
			expect(source, `${rel} does not name the app in its title`).toContain(suffix);
		}
	});

	it("builds Svelte titles from src/title.ts, because the title callback is dead there", () => {
		for (const [entry, helper, suffix] of [
			["templates/spa-svelte/src/app.ts", "templates/spa-svelte/src/title.ts", "__BLOK_SPA_NAME__"],
			["examples/inertia-svelte/client/src/main.ts", "examples/inertia-svelte/client/src/title.ts", "Blok"],
		] as const) {
			expect(read(entry), `${entry} still passes a title callback the Svelte adapter ignores`).not.toMatch(
				/^\s*title:/m,
			);
			const source = read(helper);
			expect(source, `${helper} does not name the app`).toContain(`APP_NAME = "${suffix}"`);
			expect(source, `${helper} does not build a suffixed title`).toContain("${title}");
		}

		// And every Svelte page has to go through the helper, or the suffix is
		// back to being copy-pasted per page.
		for (const rel of [
			"templates/spa-svelte/src/pages/Home.svelte",
			"templates/spa-svelte/src/pages/Errors/Error.svelte",
			"examples/inertia-svelte/client/src/pages/Dashboard.svelte",
		]) {
			const source = read(rel);
			expect(source, `${rel} hard-codes its <title>`).toContain("pageTitle(");
			expect(source, `${rel} hard-codes its <title>`).toMatch(/<title>\{pageTitle\(/);
		}
	});

	/**
	 * #1018 — the auth kit ships its own stylesheet instead of growing
	 * `blok.css`, which is byte-compared across seven clients above. Its three
	 * copies are held together the same way.
	 */
	it("has the same auth.css bytes in all three kit templates", () => {
		assertIdentical(
			KIT_DIRS.map((dir) => `${dir}/styles/auth.css`),
			"auth.css",
		);
		// ...and it must NOT have leaked into the shared stylesheet, whose bytes
		// are shared with four examples this issue does not touch.
		expect(read(`${CLIENT_SRC_DIRS[0]}/styles/blok.css`)).not.toContain(".blok-guest");
	});

	it("declares the same five pages for every kit framework", () => {
		assertIdentical(
			KIT_DIRS.map((dir) => `${dir}/blok-pages.d.ts`),
			"the kit's blok-pages.d.ts",
		);
		for (const [dir, ext] of KIT_DIRS.map((dir, i) => [dir, ["tsx", "vue", "svelte"][i]] as const)) {
			for (const page of ["Auth/Login", "Auth/Register", "Auth/ForgotPassword", "Auth/ResetPassword", "Dashboard"]) {
				const rel = `${dir}/pages/${page}.${ext}`;
				expect(readFileSync(path.join(ROOT, rel), "utf8").length, `${rel} is empty`).toBeGreaterThan(0);
			}
			expect(readFileSync(path.join(ROOT, `${dir}/components/GuestLayout.${ext}`), "utf8")).toContain("blok-guest");
		}
	});

	/**
	 * The header's sign-out is a POST — a GET logout is CSRF-able and gets
	 * pre-fetched by browsers and link scanners — and it renders only when
	 * someone is signed in, because the kit-less scaffold has no `/logout`.
	 */
	it("signs out with a POST, in every framework, only when signed in", () => {
		for (const rel of [
			"templates/spa-react/src/components/AppLayout.tsx",
			"templates/spa-vue/src/components/AppLayout.vue",
			"templates/spa-svelte/src/components/AppLayout.svelte",
		]) {
			const source = read(rel);
			// The two attributes TOGETHER: `method="post"` on its own also matches
			// the comment above the component, which is not a sign-out button.
			expect(source, `${rel} has no POST sign-out`).toContain('href="/logout" method="post"');
			expect(source, `${rel} renders sign-out for a guest`).toMatch(/if\s*\(?!?user|v-if="user"|\{#if user\}/);
		}
	});

	it("inlines the Blok mark as the favicon instead of hotlinking a logo", () => {
		const theme = read(`${CLIENT_SRC_DIRS[0]}/styles/theme.ts`);
		expect(theme).toContain("data:image/svg+xml,");
		expect(theme.toLowerCase()).toContain(BRAND_GREEN.replace("#", "%23"));
		expect(theme, "the favicon must not be fetched over the network").not.toMatch(/https?:\/\/[^"']*\.svg/);
	});
});

// =============================================================================
// Contrast
// =============================================================================

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	const value = hex.replace("#", "");
	const full =
		value.length === 3
			? value
					.split("")
					.map((c) => c + c)
					.join("")
			: value;
	return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
	const [r, g, b] = parseHex(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * The tokens declared by ONE `:root`-ish block of `blok.css`, so this gate
 * reads the shipped palette instead of a copy of it that can rot.
 */
function tokensIn(css: string, selector: string): Record<string, string> {
	const start = css.indexOf(selector);
	expect(start, `blok.css has no "${selector}" block`).toBeGreaterThanOrEqual(0);
	const open = css.indexOf("{", start);
	const block = css.slice(open, css.indexOf("}", open));
	const out: Record<string, string> = {};
	for (const [, name, value] of block.matchAll(/(--blok-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8});/g)) {
		out[name] = value.toLowerCase();
	}
	return out;
}

/** [foreground token, background token, minimum ratio, what it is]. */
const PAIRS: [string, string, number, string][] = [
	["--blok-text-strong", "--blok-surface", 4.5, "headings on a card"],
	["--blok-text-strong", "--blok-bg", 4.5, "headings on the page"],
	["--blok-text", "--blok-surface", 4.5, "body text on a card"],
	["--blok-text", "--blok-bg", 4.5, "body text on the page"],
	["--blok-muted", "--blok-surface", 4.5, "muted text on a card"],
	["--blok-muted", "--blok-bg", 4.5, "muted text on the page"],
	["--blok-muted", "--blok-surface-2", 4.5, "table headers"],
	["--blok-accent-ink", "--blok-surface", 4.5, "links and green text on a card"],
	["--blok-accent-ink", "--blok-bg", 4.5, "links and green text on the page"],
	["--blok-danger", "--blok-surface", 4.5, "validation errors"],
	["--blok-on-accent", "--blok-accent", 4.5, "the primary button's label"],
	// Non-text UI: WCAG 1.4.11 asks for 3:1, not 4.5:1. The BOUNDARY is what the
	// rule is about, so the green button is measured by its rim — the brand green
	// fill itself is 1.90:1 on a light page and is not the identifying edge.
	["--blok-accent-border", "--blok-bg", 3, "the primary button's boundary"],
	["--blok-focus", "--blok-bg", 3, "the focus ring"],
	["--blok-line-strong", "--blok-surface", 1.4, "input borders"],
];

describe("the palette clears WCAG AA in both themes", () => {
	const css = read(`${CLIENT_SRC_DIRS[0]}/styles/blok.css`);
	const themes: [string, Record<string, string>][] = [
		["light", tokensIn(css, ":root {")],
		["dark", tokensIn(css, ':root[data-theme="dark"]')],
	];

	for (const [theme, tokens] of themes) {
		for (const [fg, bg, min, what] of PAIRS) {
			it(`${theme}: ${what} — ${fg} on ${bg} is at least ${min}:1`, () => {
				expect(tokens[fg], `${fg} is not declared in the ${theme} block`).toBeDefined();
				expect(tokens[bg], `${bg} is not declared in the ${theme} block`).toBeDefined();
				const ratio = contrast(tokens[fg], tokens[bg]);
				// Printed so the PR can quote the measured table.
				console.log(`${theme.padEnd(5)} ${fg} on ${bg}: ${ratio.toFixed(2)}:1 (min ${min}) — ${what}`);
				expect(ratio).toBeGreaterThanOrEqual(min);
			});
		}
	}

	it("keeps the dark palette identical between the media query and the explicit toggle", () => {
		const auto = tokensIn(css, ':root:not([data-theme="light"])');
		const explicit = tokensIn(css, ':root[data-theme="dark"]');
		expect(explicit).toEqual(auto);
	});

	it("uses the brand green as the accent fill in both themes", () => {
		for (const [, tokens] of themes) expect(tokens["--blok-accent"]).toBe(BRAND_GREEN);
	});
});
