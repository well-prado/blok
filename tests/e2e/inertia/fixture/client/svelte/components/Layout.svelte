<script lang="ts">
/**
 * The persistent layout every fixture page re-exports.
 *
 * Inertia keeps this component MOUNTED across visits (only the page below it
 * gets a fresh key), so the navigation and the signed-in identity survive a
 * page swap — which is what scenarios 2, 3, 13, 35, 36 and 37 navigate with.
 * Every control carries a `data-testid`: the same ids exist in the React and
 * Vue fixtures, so ONE spec drives all three.
 */
import { Link, page } from "@inertiajs/svelte";
import type { Snippet } from "svelte";

const { children }: { children?: Snippet } = $props();

const email = $derived((page.props.auth as { email?: string } | undefined)?.email ?? "");

// See `client/react/components/Layout.tsx` — the SSR pre-hydration click race.
let hydrated = $state(false);
$effect(() => {
	hydrated = true;
});
</script>

<div data-hydrated={hydrated ? "true" : undefined}>
	<header>
		<nav>
			<Link href="/" data-testid="nav-home">Home</Link>
			<Link href="/orders" data-testid="nav-orders">Orders</Link>
			<Link href="/dashboard" data-testid="nav-dashboard">Dashboard</Link>
			<Link href="/secret" data-testid="nav-secret">Secret</Link>
			<Link href="/login" data-testid="nav-login">Login</Link>
		</nav>
		<span data-testid="auth-email">{email}</span>
	</header>
	<main>{@render children?.()}</main>
</div>
