<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../components/AppLayout.svelte";
</script>

<script lang="ts">
/**
 * The welcome page. Everything it shows is real: `home.title` and `home.body`
 * come from `src/nodes/home-greeting`, one node, one prop, resolved by the
 * `page` control step in `src/workflows/home.ts`.
 *
 * Delete it once your own first page exists — it is an example, not a runtime.
 */
import type { PageProps } from "@blokjs/inertia-client";
import BlokLogo from "../components/BlokLogo.svelte";

const { home }: PageProps<"Home"> = $props();

const pageSample = `export const Home = definePage("Home", {
  home: homeGreeting,
});

export default workflow("home", {
  version: "1.0.0",
  trigger: http.get("/"),
}, (req) => {
  Home.render(req, "page", "/", {});
});`;

const propsSample = `definePage("Dashboard", {
  auth:   always(currentUser),  // TS
  orders: listOrders,           // TS
  stats:  defer(pythonStats),   // Python
  posts:  scroll(listPosts),    // scroll
  plans:  once(loadPlans),      // cached
});`;

const typesSample = `import type { PageProps }
  from "@blokjs/inertia-client";

const { home }: PageProps<"Home"> =
  $props();

// home.title is typed from the node's
// Zod output schema.`;
</script>

<svelte:head>
	<title>Home</title>
</svelte:head>

<section class="blok-hero">
	<span class="blok-hero__mark"><BlokLogo variant="mark" height={56} title="Blok" /></span>
	<h1>{home.title}</h1>
	<p>{home.body}</p>
	<div class="blok-hero__actions">
		<a class="blok-btn blok-btn--primary" href="https://blok.build/d/spa" rel="noreferrer">Read the docs</a>
		<a class="blok-btn" href="https://blok.build/d/studio" rel="noreferrer">Open Studio</a>
	</div>
</section>

<div class="blok-features">
	<article class="blok-feature">
		<h2>Pages are workflows</h2>
		<p>A route, a contract and a render call. No controller, no view layer.</p>
		<pre class="blok-code"><code>{pageSample}</code></pre>
	</article>

	<article class="blok-feature">
		<h2>Props are steps, in any runtime</h2>
		<p>Each prop is one node. Resolved in parallel, per visit, in the language you picked.</p>
		<pre class="blok-code"><code>{propsSample}</code></pre>
	</article>

	<article class="blok-feature">
		<h2>Type-safe from server to component</h2>
		<p><code>blokctl gen app-types</code> turns the Zod output schemas into the props this page is typed with.</p>
		<pre class="blok-code"><code>{typesSample}</code></pre>
	</article>
</div>

<div class="blok-card">
	<div class="blok-card__header">
		<h2>What this scaffold already gives you</h2>
	</div>
	<div class="blok-card__body">
		<ul class="blok-checklist">
			<li>Typed props, generated from your nodes</li>
			<li>Flash messages over a signed one-shot cookie</li>
			<li>CSRF, via the <code>inertia.csrf</code> middleware</li>
			<li>Production error pages (403/404/500/503)</li>
			<li>SSR-ready — <code>blokctl inertia start-ssr</code></li>
			<li>Light and dark, with a header toggle</li>
		</ul>
	</div>
</div>
