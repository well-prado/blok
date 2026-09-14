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
			<h1>{auth.email}</h1>

			<ul>
				{orders.map((order) => (
					<li key={order.id}>
						{order.sku} — {order.total}
					</li>
				))}
			</ul>

			{/* Deferred: announced on the full visit, fetched right after. */}
			<Deferred data="stats" fallback={<p>Loading stats…</p>}>
				<p>Revenue: {stats?.revenue}</p>
			</Deferred>

			{/* Once: the client keeps this between visits and the node stops running. */}
			<WhenVisible data="plans" fallback={<p>…</p>}>
				<ul>
					{plans.map((plan) => (
						<li key={plan.id}>{plan.price}</li>
					))}
				</ul>
			</WhenVisible>

			{/* Scroll: the client grows posts.data and replaces the cursors. */}
			<InfiniteScroll data="posts">
				{posts.data.map((post) => (
					<p key={post.id}>{post.title}</p>
				))}
			</InfiniteScroll>

			<Link href="/orders/new">New order</Link>
		</main>
	);
}
