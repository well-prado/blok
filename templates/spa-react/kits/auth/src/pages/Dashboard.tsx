import type { PageProps } from "@blokjs/inertia-client";
import { Head, Link } from "@inertiajs/react";
import { appLayout } from "../components/AppLayout.js";

/**
 * `Dashboard` — the guarded landing page (#1018).
 *
 * `GET /dashboard` carries the `inertia.auth` middleware, so a guest is
 * redirected to `/login` BEFORE any step of this page runs: there is no
 * "logged out" state to render here.
 *
 * Delete it once your own first signed-in page exists.
 */
export default function Dashboard({ auth }: PageProps<"Dashboard">) {
	return (
		<>
			<Head title="Dashboard" />

			<div className="blok-page-header">
				<div>
					<p className="blok-eyebrow">Signed in</p>
					<h1>Hello, {auth.user?.name ?? "there"}</h1>
					<p className="blok-lede">
						This page is guarded by <code>inertia.auth</code>. Sign out and open it again — you land on
						<code> /login</code> without the workflow running.
					</p>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>Your account</h2>
					<span className="blok-badge">session</span>
				</div>
				<div className="blok-card__body">
					<ul className="blok-checklist">
						<li>{auth.user?.email}</li>
						<li>The session id is a signed, HttpOnly cookie — the data stays on the server.</li>
						<li>Signing out destroys the session, clears the history and rotates the CSRF token.</li>
					</ul>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>What the kit wired for you</h2>
				</div>
				<div className="blok-card__body">
					<ul className="blok-checklist">
						<li>
							<code>@blokjs/session</code> — signed cookie, SQLite store
						</li>
						<li>
							<code>@blokjs/auth</code> — scrypt hashing, throttled sign-in, single-use reset tokens
						</li>
						<li>
							Routes under <code>src/workflows/auth/</code> — yours to edit
						</li>
						<li>
							Pages under <code>client/src/pages/Auth/</code>
						</li>
					</ul>
					<p className="blok-form__actions">
						<Link href="/" className="blok-btn">
							Back to the welcome page
						</Link>
					</p>
				</div>
			</div>
		</>
	);
}

Dashboard.layout = appLayout;
