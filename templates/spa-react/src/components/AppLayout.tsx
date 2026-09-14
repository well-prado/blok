import { Link, usePage } from "@inertiajs/react";
import type { MouseEvent, ReactNode } from "react";
import { toggleTheme } from "../styles/theme.js";
import { BlokLogo, ThemeIcons } from "./BlokLogo.js";

/**
 * The persistent layout. Inertia keeps this component MOUNTED across visits
 * (`Page.layout = (page) => <AppLayout>{page}</AppLayout>`), so the header,
 * the theme toggle and any state they hold survive navigation — only the page
 * below swaps.
 */

interface NavItem {
	href: string;
	label: string;
	external?: boolean;
}

/** Your app's primary nav. Add a route here and the 375px menu gets it too. */
const NAV: NavItem[] = [
	{ href: "/", label: "Home" },
	{ href: "https://blok.build", label: "Docs", external: true },
	{ href: "https://github.com/well-prado/blok", label: "GitHub", external: true },
];

/**
 * The 375px menu is a native `<details>` inside a PERSISTENT layout, so an
 * Inertia visit swaps the page underneath it and leaves it open, covering the
 * page it just navigated to. One line closes it; nothing else here needs JS.
 */
function closeMenu(event: MouseEvent<Element>): void {
	event.currentTarget.closest("details")?.removeAttribute("open");
}

function navLinks(url: string): ReactNode {
	return NAV.map((item) =>
		item.external === true ? (
			<a key={item.href} href={item.href} rel="noreferrer" onClick={closeMenu}>
				{item.label}
			</a>
		) : (
			<Link key={item.href} href={item.href} onClick={closeMenu} aria-current={url === item.href ? "page" : undefined}>
				{item.label}
			</Link>
		),
	);
}

export function AppLayout({ children }: { children: ReactNode }) {
	const { url, props } = usePage<{ auth?: { email?: string } }>();
	const email = props.auth?.email;

	return (
		<div className="blok-shell">
			<header className="blok-header">
				<div className="blok-container blok-header__inner">
					<Link href="/" className="blok-brand" aria-label="Blok — home">
						<BlokLogo height={22} />
					</Link>

					<nav className="blok-nav" aria-label="Primary">
						{navLinks(url)}
					</nav>

					<div className="blok-header__end">
						{email === undefined ? null : <span className="blok-user">{email}</span>}
						<button
							type="button"
							className="blok-btn blok-btn--ghost blok-btn--icon blok-theme-toggle"
							onClick={() => toggleTheme()}
							aria-label="Switch between light and dark theme"
						>
							<ThemeIcons />
						</button>

						{/* A native <details>: the 375px menu ships no JavaScript. */}
						<details className="blok-menu">
							<summary className="blok-btn blok-btn--ghost blok-btn--icon" aria-label="Menu">
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									aria-hidden="true"
								>
									<path d="M3 6h18M3 12h18M3 18h18" />
								</svg>
							</summary>
							<div className="blok-menu__panel">
								{email === undefined ? null : <p className="blok-menu__user">{email}</p>}
								<nav className="blok-nav" aria-label="Primary, compact">
									{navLinks(url)}
								</nav>
							</div>
						</details>
					</div>
				</div>
			</header>

			<main className="blok-main">
				<div className="blok-container">{children}</div>
			</main>

			<footer className="blok-footer">
				<div className="blok-container blok-footer__inner">
					<BlokLogo variant="mark" height={16} />
					<span>Built with Blok</span>
					<span aria-hidden="true">·</span>
					<a href="https://blok.build" rel="noreferrer">
						blok.build
					</a>
					<span aria-hidden="true">·</span>
					<a href="https://github.com/well-prado/blok" rel="noreferrer">
						GitHub
					</a>
					<span aria-hidden="true">·</span>
					<a href="https://deskree.com" rel="noreferrer">
						Deskree
					</a>
				</div>
			</footer>
		</div>
	);
}

/** Sugar for `Page.layout = …` — one import per page instead of two. */
export const appLayout = (page: ReactNode): ReactNode => <AppLayout>{page}</AppLayout>;
