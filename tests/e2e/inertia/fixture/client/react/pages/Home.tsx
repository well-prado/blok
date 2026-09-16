import type { PageProps } from "@blokjs/inertia-client";
import { Head, Link } from "@inertiajs/react";
import { layout } from "../components/Layout.js";

/**
 * Home.
 *
 * It reads its props through the GENERATED `PageProps<"Home">`, which is what
 * makes scenario 19 a real gate: renaming `home:` in `src/workflows/home.ts`
 * and regenerating the types has to make this file stop compiling.
 *
 * The prefetch and instant links live here rather than in the layout so a plain
 * `<Link>` click (scenario 2) cannot be confused with a prefetching one.
 */
export default function Home({ home }: PageProps<"Home">) {
	return (
		<>
			<Head title="Home" />
			<h1 data-testid="page-heading">Home</h1>
			<p data-testid="home-body">{home.body}</p>
			{/* The `</script>` payload, rendered as TEXT. `window.pwned` staying
			    undefined is the end-to-end proof that the boot script is escaped. */}
			<p data-testid="home-payload">{home.payload}</p>
			<Link href="/orders" prefetch cacheFor="1s" data-testid="prefetch-orders">
				Prefetch orders
			</Link>{" "}
			<Link href="/dashboard" instant data-testid="instant-dashboard">
				Instant dashboard
			</Link>
		</>
	);
}

Home.layout = layout;
