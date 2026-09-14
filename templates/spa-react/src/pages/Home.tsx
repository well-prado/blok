import type { PageProps } from "@blokjs/inertia-client";
import { Head } from "@inertiajs/react";
import { appLayout } from "../components/AppLayout.js";
import { BlokLogo } from "../components/BlokLogo.js";

/**
 * The welcome page. Everything it shows is real: `home.title` and `home.body`
 * come from `src/nodes/home-greeting`, one node, one prop, resolved by the
 * `page` control step in `src/workflows/home.ts`.
 *
 * Delete it once your own first page exists — it is an example, not a runtime.
 */
export default function Home({ home }: PageProps<"Home">) {
	return (
		<>
			<Head title="Home" />

			<section className="blok-hero">
				<span className="blok-hero__mark">
					<BlokLogo variant="mark" height={56} title="Blok" />
				</span>
				<h1>{home.title}</h1>
				<p>{home.body}</p>
				<div className="blok-hero__actions">
					<a className="blok-btn blok-btn--primary" href="https://blok.build/d/spa" rel="noreferrer">
						Read the docs
					</a>
					<a className="blok-btn" href="https://blok.build/d/studio" rel="noreferrer">
						Open Studio
					</a>
				</div>
			</section>

			<div className="blok-features">
				<article className="blok-feature">
					<h2>Pages are workflows</h2>
					<p>A route, a contract and a render call. No controller, no view layer.</p>
					<pre className="blok-code">
						<code>{`export const Home = definePage("Home", {
  home: homeGreeting,
});

export default workflow("home", {
  version: "1.0.0",
  trigger: http.get("/"),
}, (req) => {
  Home.render(req, "page", "/", {});
});`}</code>
					</pre>
				</article>

				<article className="blok-feature">
					<h2>Props are steps, in any runtime</h2>
					<p>Each prop is one node. Resolved in parallel, per visit, in the language you picked.</p>
					<pre className="blok-code">
						<code>{`definePage("Dashboard", {
  auth:   always(currentUser),  // TS
  orders: listOrders,           // TS
  stats:  defer(pythonStats),   // Python
  posts:  scroll(listPosts),    // scroll
  plans:  once(loadPlans),      // cached
});`}</code>
					</pre>
				</article>

				<article className="blok-feature">
					<h2>Type-safe from server to component</h2>
					<p>
						<code>blokctl gen app-types</code> turns the Zod output schemas into the props this component is typed with.
					</p>
					<pre className="blok-code">
						<code>{`import type { PageProps }
  from "@blokjs/inertia-client";

export default function Home(
  { home }: PageProps<"Home">,
) {
  return <h1>{home.title}</h1>;
}`}</code>
					</pre>
				</article>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>What this scaffold already gives you</h2>
				</div>
				<div className="blok-card__body">
					<ul className="blok-checklist">
						<li>Typed props, generated from your nodes</li>
						<li>Flash messages over a signed one-shot cookie</li>
						<li>
							CSRF, via the <code>inertia.csrf</code> middleware
						</li>
						<li>Production error pages (403/404/500/503)</li>
						<li>
							SSR-ready — <code>blokctl inertia start-ssr</code>
						</li>
						<li>Light and dark, with a header toggle</li>
					</ul>
				</div>
			</div>
		</>
	);
}

Home.layout = appLayout;
