import { Link } from "@inertiajs/react";
import type { ReactNode } from "react";
import "../styles/auth.css";
import { toggleTheme } from "../styles/theme.js";
import { BlokLogo, ThemeIcons } from "./BlokLogo.js";

/**
 * The layout for the signed-OUT screens (#1018): one centred card, no nav, no
 * user menu — there is no user yet.
 *
 * Like `AppLayout` it is a PERSISTENT Inertia layout, so moving between
 * sign-in, register and password reset swaps only the card's contents.
 */
export function GuestLayout({ children }: { children: ReactNode }) {
	return (
		<div className="blok-guest">
			<button
				type="button"
				className="blok-btn blok-btn--ghost blok-btn--icon blok-theme-toggle blok-guest__toggle"
				onClick={() => toggleTheme()}
				aria-label="Switch between light and dark theme"
			>
				<ThemeIcons />
			</button>

			<div className="blok-guest__card">
				<Link href="/" className="blok-guest__brand" aria-label="Blok — home">
					<BlokLogo height={24} />
				</Link>
				{children}
			</div>

			<p className="blok-guest__foot">
				<span>Built with Blok</span>
				<span aria-hidden="true">·</span>
				<a href="https://blok.build/d/spa/starter-kit" rel="noreferrer">
					Starter kit docs
				</a>
			</p>
		</div>
	);
}

/** Sugar for `Page.layout = …` — one import per page instead of two. */
export const guestLayout = (page: ReactNode): ReactNode => <GuestLayout>{page}</GuestLayout>;
