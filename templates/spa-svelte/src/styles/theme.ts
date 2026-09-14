/**
 * Theme toggle and favicon for the Blok SPA design system.
 *
 * Framework-agnostic on purpose: React, Vue and Svelte all call the same three
 * functions from their client entry, and the header's toggle is a plain
 * `<button onclick={toggleTheme}>` in each. Which icon that button shows is
 * decided in `blok.css`, not here, so there is no component state to keep in
 * sync and nothing flickers on the first paint.
 *
 * The SAME BYTES ship in every template and example — `tests/docs/spa-design.test.ts`
 * fails if they drift.
 */

export type BlokTheme = "light" | "dark";

/** localStorage key. Absent = follow the OS, which is the default. */
const STORAGE_KEY = "blok-theme";

/** The Blok mark (`docs/assets/logo/mark.svg`), inlined so it needs no route. */
const FAVICON =
	"data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2040%2032%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M4.58288%2011.1045C4.86346%2010.823%205.31836%2010.823%205.59894%2011.1045L9.97138%2015.4904C10.252%2015.7718%2010.252%2016.2282%209.97139%2016.5096L5.59894%2020.8955C5.31836%2021.177%204.86346%2021.177%204.58288%2020.8955L0.210434%2016.5096C-0.0701446%2016.2282%20-0.0701449%2015.7718%200.210434%2015.4904L4.58288%2011.1045Z%22%20fill%3D%22%232BCD71%22%2F%3E%3Cpath%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20d%3D%22M20.7107%2011.1972C20.2692%2010.9492%2019.7308%2010.9492%2019.2893%2011.1972L15.9966%2013.0468C15.5373%2013.3048%2015.2528%2013.7917%2015.2528%2014.3198V17.6802C15.2528%2018.2083%2015.5373%2018.6952%2015.9966%2018.9532L19.2893%2020.8028C19.7308%2021.0508%2020.2692%2021.0508%2020.7107%2020.8028L24.0034%2018.9532C24.4627%2018.6952%2024.7472%2018.2083%2024.7472%2017.6802V14.3198C24.7472%2013.7917%2024.4627%2013.3048%2024.0034%2013.0468L20.7107%2011.1972ZM29.0909%2011.7486C29.0909%2011.2205%2028.8064%2010.7336%2028.3471%2010.4756L20.7107%206.18602C20.2692%205.93799%2019.7308%205.93799%2019.2893%206.18602L11.6529%2010.4756C11.1936%2010.7336%2010.9091%2011.2205%2010.9091%2011.7486V20.2514C10.9091%2020.7795%2011.1936%2021.2664%2011.6529%2021.5244L19.2893%2025.814C19.7308%2026.062%2020.2692%2026.062%2020.7107%2025.814L28.3471%2021.5244C28.8064%2021.2664%2029.0909%2020.7795%2029.0909%2020.2514V11.7486Z%22%20fill%3D%22%232BCD71%22%2F%3E%3Cpath%20d%3D%22M34.4011%2011.1045C34.6816%2010.823%2035.1365%2010.823%2035.4171%2011.1045L39.7896%2015.4904C40.0701%2015.7718%2040.0701%2016.2282%2039.7896%2016.5096L35.4171%2020.8955C35.1365%2021.177%2034.6816%2021.177%2034.4011%2020.8955L30.0286%2016.5096C29.748%2016.2282%2029.748%2015.7718%2030.0286%2015.4904L34.4011%2011.1045Z%22%20fill%3D%22%232BCD71%22%2F%3E%3C%2Fsvg%3E";

function stored(): BlokTheme | null {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return value === "light" || value === "dark" ? value : null;
	} catch {
		// Private mode, or storage disabled: the OS preference still works.
		return null;
	}
}

/** What the page is showing right now — the stored choice, else the OS. */
export function currentTheme(): BlokTheme {
	if (typeof document === "undefined") return "light";
	const explicit = document.documentElement.dataset.theme;
	if (explicit === "light" || explicit === "dark") return explicit;
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Pin a theme: `data-theme` on <html> beats `prefers-color-scheme` both ways. */
export function setTheme(theme: BlokTheme): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Not persisting is survivable; not switching is not.
	}
}

/** Header button handler. */
export function toggleTheme(): BlokTheme {
	const next: BlokTheme = currentTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}

/** Re-apply a stored choice on boot. No choice stored → the OS decides. */
export function initTheme(): void {
	const choice = stored();
	if (choice !== null) setTheme(choice);
}

/**
 * The tab icon. Set from script rather than from the HTML shell because the
 * production shell is the adapter's default (`@blokjs/inertia`) and the Blok
 * server only serves `/assets/*` out of the client build — a `public/mark.svg`
 * would 404. A data URI needs no route at all.
 */
export function installFavicon(): void {
	if (typeof document === "undefined") return;
	const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement("link");
	link.rel = "icon";
	link.type = "image/svg+xml";
	link.href = FAVICON;
	if (link.parentNode === null) document.head.append(link);
}
