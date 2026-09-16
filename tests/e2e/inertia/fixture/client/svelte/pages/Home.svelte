<script module lang="ts">
export { default as layout } from "../components/Layout.svelte";
</script>

<script lang="ts">
/**
 * Home.
 *
 * Its props are typed through the GENERATED page contract (see
 * `../page-types.js`), which is what makes scenario 19 a real gate: renaming
 * `home:` in `src/workflows/home.ts` and regenerating the types has to make the
 * client stop compiling.
 *
 * The prefetch and instant links live here rather than in the layout so a plain
 * `<Link>` click (scenario 2) cannot be confused with a prefetching one.
 */
import { Link } from "@inertiajs/svelte";
import type { HomeProps } from "../page-types.js";
import { pageTitle } from "../title.js";

const { home }: HomeProps = $props();
</script>

<svelte:head>
	<title>{pageTitle("Home")}</title>
</svelte:head>

<h1 data-testid="page-heading">Home</h1>
<p data-testid="home-body">{home.body}</p>
<!--
	The `</script>` payload, rendered as TEXT. `window.pwned` staying undefined is
	the end-to-end proof that the boot script is escaped.
-->
<p data-testid="home-payload">{home.payload}</p>

<Link href="/orders" prefetch cacheFor="1s" data-testid="prefetch-orders">Prefetch orders</Link>
<Link href="/dashboard" instant data-testid="instant-dashboard">Instant dashboard</Link>
