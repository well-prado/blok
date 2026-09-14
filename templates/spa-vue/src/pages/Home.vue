<script setup lang="ts">
/**
 * The welcome page. Everything it shows is real: `home.title` and `home.body`
 * come from `src/nodes/home-greeting`, one node, one prop, resolved by the
 * `page` control step in `src/workflows/home.ts`.
 *
 * Delete it once your own first page exists — it is an example, not a runtime.
 *
 * ponytail: `usePage<PageProps<"Home">>()` rather than
 * `defineProps<PageProps<"Home">>()`. @vue/compiler-sfc resolves prop TYPES
 * itself, with its own resolver: it cannot follow the generic indexed access
 * inside `PageProps`, and it never sees the `declare module` augmentation in
 * `blok-pages.d.ts` either. `usePage` is plain TypeScript, so both stay honest.
 */
import type { PageProps } from "@blokjs/inertia-client";
import { Head, usePage } from "@inertiajs/vue3";
import AppLayout from "../components/AppLayout.vue";
import BlokLogo from "../components/BlokLogo.vue";

const page = usePage<PageProps<"Home">>();

defineOptions({ layout: AppLayout });

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

// No `<script>` tags in this sample on purpose: an SFC's script block ends at
// the first literal closing tag, even inside a template literal.
const typesSample = `import type { PageProps }
  from "@blokjs/inertia-client";

const page =
  usePage<PageProps<"Home">>();

// page.props.home.title is typed from
// the node's Zod output schema.`;
</script>

<template>
	<Head title="Home" />

	<section class="blok-hero">
		<span class="blok-hero__mark"><BlokLogo variant="mark" :height="56" title="Blok" /></span>
		<h1>{{ page.props.home.title }}</h1>
		<p>{{ page.props.home.body }}</p>
		<div class="blok-hero__actions">
			<a class="blok-btn blok-btn--primary" href="https://blok.build/d/spa" rel="noreferrer">Read the docs</a>
			<a class="blok-btn" href="https://blok.build/d/studio" rel="noreferrer">Open Studio</a>
		</div>
	</section>

	<div class="blok-features">
		<article class="blok-feature">
			<h2>Pages are workflows</h2>
			<p>A route, a contract and a render call. No controller, no view layer.</p>
			<pre class="blok-code"><code>{{ pageSample }}</code></pre>
		</article>

		<article class="blok-feature">
			<h2>Props are steps, in any runtime</h2>
			<p>Each prop is one node. Resolved in parallel, per visit, in the language you picked.</p>
			<pre class="blok-code"><code>{{ propsSample }}</code></pre>
		</article>

		<article class="blok-feature">
			<h2>Type-safe from server to component</h2>
			<p><code>blokctl gen app-types</code> turns the Zod output schemas into the props this page is typed with.</p>
			<pre class="blok-code"><code>{{ typesSample }}</code></pre>
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
</template>
