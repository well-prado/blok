import type { PageProps } from "@blokjs/inertia";
import { Deferred, InfiniteScroll, Link, WhenVisible } from "@inertiajs/react";
import type { Dashboard as DashboardPage } from "../../../src/workflows/dashboard.js";

/**
 * Props come straight from the page contract — `optional` and `defer` keys are
 * `T | undefined`, everything else is present. No `ctx`, no embedding: a page
 * gets the props it declared and nothing else.
 */
export default function Dashboard({ auth, orders, stats, plans, posts }: PageProps<typeof DashboardPage>) {
	return (
		<main>
			<h1>Dashboard — {auth.email}</h1>

			<section>
				<h2>Orders (regular prop)</h2>
				<ul>
					{orders.map((order) => (
						<li key={order.id}>
							{order.sku} — {order.total}
						</li>
					))}
				</ul>
			</section>

			{/* Deferred: announced on the full visit, fetched right after. The node
			    is Python, so without the python3 sidecar the prop is RESCUED and
			    the fallback simply stays — the page still renders. */}
			<section>
				<h2>Stats (deferred, Python)</h2>
				<Deferred data="stats" fallback={<p>Loading stats… (needs the python3 sidecar)</p>}>
					<p>Revenue: {stats?.revenue}</p>
				</Deferred>
			</section>

			{/* Once: the client keeps this between visits and the node stops running. */}
			<section>
				<h2>Plans (once)</h2>
				<WhenVisible data="plans" fallback={<p>…</p>}>
					<ul>
						{plans.map((plan) => (
							<li key={plan.id}>{plan.price}</li>
						))}
					</ul>
				</WhenVisible>
			</section>

			{/* Scroll: the client grows posts.data and replaces the cursors. */}
			<section>
				<h2>Posts (infinite scroll)</h2>
				<InfiniteScroll data="posts">
					{posts.data.map((post) => (
						<p key={post.id}>{post.title}</p>
					))}
				</InfiniteScroll>
			</section>

			<Link href="/orders/new">New order</Link>
		</main>
	);
}
