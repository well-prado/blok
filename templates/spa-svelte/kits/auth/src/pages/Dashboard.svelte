<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../components/AppLayout.svelte";
</script>

<script lang="ts">
/**
 * `Dashboard` — the guarded landing page (#1018).
 *
 * `GET /dashboard` carries the `inertia.auth` middleware, so a guest is
 * redirected to `/login` BEFORE any step of this page runs: there is no
 * "logged out" state to render here.
 *
 * Delete it once your own first signed-in page exists.
 */
import type { PageProps } from "@blokjs/inertia-client";
import { Link } from "@inertiajs/svelte";
import { pageTitle } from "../title.js";

const { auth }: PageProps<"Dashboard"> = $props();
</script>

<svelte:head><title>{pageTitle("Dashboard")}</title></svelte:head>

<div class="blok-page-header">
	<div>
		<p class="blok-eyebrow">Signed in</p>
		<h1>Hello, {auth.user?.name ?? "there"}</h1>
		<p class="blok-lede">
			This page is guarded by <code>inertia.auth</code>. Sign out and open it again — you land on
			<code>/login</code> without the workflow running.
		</p>
	</div>
</div>

<div class="blok-card">
	<div class="blok-card__header">
		<h2>Your account</h2>
		<span class="blok-badge">session</span>
	</div>
	<div class="blok-card__body">
		<ul class="blok-checklist">
			<li>{auth.user?.email}</li>
			<li>The session id is a signed, HttpOnly cookie — the data stays on the server.</li>
			<li>Signing out destroys the session, clears the history and rotates the CSRF token.</li>
		</ul>
	</div>
</div>

<div class="blok-card">
	<div class="blok-card__header">
		<h2>What the kit wired for you</h2>
	</div>
	<div class="blok-card__body">
		<ul class="blok-checklist">
			<li><code>@blokjs/session</code> — signed cookie, SQLite store</li>
			<li><code>@blokjs/auth</code> — scrypt hashing, throttled sign-in, single-use reset tokens</li>
			<li>Routes under <code>src/workflows/auth/</code> — yours to edit</li>
			<li>Pages under <code>client/src/pages/Auth/</code></li>
		</ul>
		<p class="blok-form__actions">
			<Link href="/" class="blok-btn">Back to the welcome page</Link>
		</p>
	</div>
</div>
