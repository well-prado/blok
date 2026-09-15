import type { PageProps } from "@blokjs/inertia";
import { Deferred, Head, InfiniteScroll, Link, WhenVisible } from "@inertiajs/react";
import type { ReactNode } from "react";
import type { Dashboard as DashboardPage } from "../../../src/workflows/dashboard.js";
import { appLayout } from "../components/AppLayout.js";

/**
 * Props come straight from the page contract — `optional` and `defer` keys are
 * `T | undefined`, everything else is present. No `ctx`, no embedding: a page
 * gets the props it declared and nothing else.
 *
 * Every tile and panel below is labelled with the PROP MODE behind it, because
 * that is the thing this example exists to show: the layout is ordinary markup
 * over `blok.css`, and the interesting part is which prop arrived when.
 */
export default function Dashboard({ auth, orders, stats, plans, posts }: PageProps<typeof DashboardPage>) {
	const revenue = orders.reduce((sum, order) => sum + order.total, 0);
	// No `can` prop on this page's contract, so the signed-out visitor (the
	// example's `guest=1` cookie) is the one who loses the row action.
	const canEdit = auth.id !== "";

	return (
		<>
			<Head title="Dashboard" />

			<div className="blok-page-header">
				<div>
					<p className="blok-eyebrow">Inertia · in-project mode</p>
					<h1>Dashboard</h1>
					<p className="blok-lede">
						One workflow, six props, five resolution modes — one of them computed by a Python node.
					</p>
				</div>
				<div className="blok-page-header__end">
					<Link href="/posts/new" className="blok-btn">
						New post
					</Link>
					<Link href="/orders/new" className="blok-btn blok-btn--primary">
						New order
					</Link>
				</div>
			</div>

			<div className="blok-stats">
				{/* Deferred, and Python: announced on the full visit, fetched right
				    after. `rescue` is what the page shows when the sidecar is not
				    running — the prop is rescued and the page still renders. */}
				<div className="blok-stat">
					<p className="blok-stat__label">Revenue (Python)</p>
					<Deferred
						data="stats"
						fallback={
							<>
								<div className="blok-skeleton blok-skeleton--wide" style={{ height: "1.75rem" }} />
								<div className="blok-skeleton" style={{ width: "40%" }} />
							</>
						}
						rescue={
							<>
								<p className="blok-stat__value">—</p>
								<p className="blok-stat__delta">runtime.python3 sidecar not running</p>
							</>
						}
					>
						<p className="blok-stat__value">${stats?.revenue ?? 0}</p>
						<p className="blok-stat__delta blok-stat__delta--up">defer() · runtime.python3</p>
					</Deferred>
				</div>

				<StatTile label="Orders" value={orders.length} delta="regular prop" />
				<StatTile label="Order value" value={`$${revenue}`} delta="derived on the client" up />
				<StatTile label="Posts" value={posts.total} delta={`scroll() · ${posts.perPage} per page`} />
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>Orders</h2>
					<span className="blok-badge">regular</span>
				</div>
				<div className="blok-table-wrap">
					<table className="blok-table">
						<thead>
							<tr>
								<th scope="col">Order</th>
								<th scope="col">SKU</th>
								<th scope="col" className="blok-num">
									Total
								</th>
								<th scope="col" className="blok-actions">
									<span className="blok-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{orders.map((order) => (
								<tr key={order.id}>
									<td>
										<code>{order.id}</code>
									</td>
									<td>{order.sku}</td>
									<td className="blok-num">${order.total}</td>
									<td className="blok-actions">
										{/* There is no edit route in this example, so the action is an
										    `aria-disabled` control rather than a <Link> that 404s. It stays
										    focusable on purpose, so the reason is reachable. */}
										{canEdit ? (
											<button
												type="button"
												className="blok-btn blok-btn--ghost"
												aria-disabled="true"
												title="This example has no edit route yet"
											>
												Edit
											</button>
										) : (
											<span className="blok-muted">—</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>Plans</h2>
					<span className="blok-badge">once</span>
				</div>
				{/* Once: the client keeps this between visits and the node stops running. */}
				<WhenVisible
					data="plans"
					fallback={
						<div className="blok-card__body">
							<div className="blok-skeleton blok-skeleton--wide" />
							<div className="blok-skeleton" />
						</div>
					}
				>
					<ul className="blok-feed">
						{plans.map((plan) => (
							<li key={plan.id}>
								<span>{plan.id}</span>
								<span className="blok-feed__meta">${plan.price}/mo</span>
							</li>
						))}
					</ul>
				</WhenVisible>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>Posts</h2>
					<span className="blok-badge">infinite scroll</span>
				</div>
				{/* Scroll: the client grows posts.data and replaces the cursors. */}
				<InfiniteScroll
					data="posts"
					loading={
						<p className="blok-end-of-list">
							<span className="blok-spinner" /> Loading more posts…
						</p>
					}
					next={({ hasMore }) =>
						hasMore ? null : <p className="blok-end-of-list">That is all {posts.total} posts.</p>
					}
				>
					<ul className="blok-feed">
						{posts.data.map((post) => (
							<li key={post.id}>
								<span>{post.title}</span>
								<span className="blok-feed__meta">{post.id}</span>
							</li>
						))}
					</ul>
				</InfiniteScroll>
			</div>
		</>
	);
}

function StatTile({
	label,
	value,
	delta,
	up = false,
}: {
	label: string;
	value: ReactNode;
	delta: string;
	up?: boolean;
}) {
	return (
		<div className="blok-stat">
			<p className="blok-stat__label">{label}</p>
			<p className="blok-stat__value">{value}</p>
			<p className={up ? "blok-stat__delta blok-stat__delta--up" : "blok-stat__delta"}>{delta}</p>
		</div>
	);
}

// The persistent layout: Inertia keeps <AppLayout> mounted across visits.
Dashboard.layout = appLayout;
