import { Link, usePage } from "@inertiajs/react";
import { type ReactNode, useEffect, useState } from "react";

/**
 * The persistent layout every fixture page mounts under.
 *
 * Inertia keeps this component MOUNTED across visits, so the navigation and the
 * signed-in identity survive a page swap — which is what scenarios 2, 3, 13, 35,
 * 36 and 37 navigate with. Every control carries a `data-testid`: the same ids
 * exist in the Vue and Svelte fixtures, so ONE spec drives all three.
 *
 * The root carries `data-hydrated` once the client has taken over. Under SSR the
 * markup is interactive-LOOKING before hydration, so a click that lands first
 * hits a plain `<form>` with no submit handler and the browser navigates
 * natively — a real race, and the reason every `open()` in the spec waits for
 * this attribute. It is set AFTER mount, so the first render still matches what
 * the server sent.
 */
export function Layout({ children }: { children: ReactNode }) {
	const { props } = usePage<{ auth?: { email?: string } }>();
	const email = props.auth?.email ?? "";
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);

	return (
		<div data-hydrated={hydrated ? "true" : undefined}>
			<header>
				<nav>
					<Link href="/" data-testid="nav-home">
						Home
					</Link>{" "}
					<Link href="/orders" data-testid="nav-orders">
						Orders
					</Link>{" "}
					<Link href="/dashboard" data-testid="nav-dashboard">
						Dashboard
					</Link>{" "}
					<Link href="/secret" data-testid="nav-secret">
						Secret
					</Link>{" "}
					<Link href="/login" data-testid="nav-login">
						Login
					</Link>
				</nav>
				<span data-testid="auth-email">{email}</span>
			</header>
			<main>{children}</main>
		</div>
	);
}

/** Sugar for `Page.layout = …`. */
export const layout = (page: ReactNode): ReactNode => <Layout>{page}</Layout>;
