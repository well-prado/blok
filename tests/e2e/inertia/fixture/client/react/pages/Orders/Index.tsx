import { Head, InfiniteScroll, Link, router } from "@inertiajs/react";
import { layout } from "../../components/Layout.js";

interface Order {
	id: string;
	sku: string;
	title: string;
	qty: number;
}

interface Props {
	orders: { data: Order[]; total: number };
	filters?: { status: string };
	plans: { id: string; price: number }[];
	feed: { data: { id: string; label: string }[]; total: number };
}

/**
 * The list page: every partial-reload mode on one screen.
 *
 * `orders` is a `merge()` prop (append + match on `id`), `feed` a `scroll()`
 * prop, `filters` an `optional()` prop and `plans` a `once()` prop — so the
 * buttons below drive scenarios 9, 21, 22, 24 and 25 against real requests
 * rather than a mocked router.
 */
export default function Index({ orders, filters, plans, feed }: Props) {
	return (
		<>
			<Head title="Orders" />
			<h1 data-testid="page-heading">Orders</h1>

			<p data-testid="orders-total">{orders.total}</p>

			<div>
				<button type="button" data-testid="orders-reload" onClick={() => router.reload({ only: ["orders"] })}>
					Reload orders
				</button>
				<button type="button" data-testid="orders-except" onClick={() => router.reload({ except: ["orders"] })}>
					Reload except orders
				</button>
				<button
					type="button"
					data-testid="orders-more"
					onClick={() => router.reload({ only: ["orders"], data: { page: "2" } })}
				>
					Load more
				</button>
				<button
					type="button"
					data-testid="orders-update"
					onClick={() => router.reload({ only: ["orders"], data: { bump: "1" } })}
				>
					Update existing
				</button>
				<button type="button" data-testid="filters-load" onClick={() => router.reload({ only: ["filters"] })}>
					Load filters
				</button>
				<button type="button" data-testid="plans-reload" onClick={() => router.reload({ only: ["plans"] })}>
					Reload plans
				</button>
				<button
					type="button"
					data-testid="feed-more"
					onClick={() => router.reload({ only: ["feed"], data: { feed: "2" } })}
				>
					More feed
				</button>
				<button
					type="button"
					data-testid="feed-reset"
					onClick={() => router.visit("/orders", { only: ["feed"], reset: ["feed"], preserveState: true })}
				>
					Reset feed
				</button>
			</div>

			<div>
				<Link href="/orders/create" data-testid="orders-create-link">
					New order
				</Link>{" "}
				<Link href="/__e2e/external" data-testid="external-link">
					External
				</Link>{" "}
				<Link href="/__e2e/fragment" data-testid="fragment-link">
					Fragment
				</Link>
			</div>

			{filters ? (
				<p data-filters data-testid="filters">
					{filters.status}
				</p>
			) : null}
			{plans ? (
				<ul data-plans data-testid="plans">
					{plans.map((plan) => (
						<li key={plan.id}>{plan.id}</li>
					))}
				</ul>
			) : null}

			<ul>
				{orders.data.map((order) => (
					// Tall rows on purpose: scenario 4 scrolls past 600px before it
					// navigates, and a short list would never leave the fold.
					<li key={order.id} data-order-id={order.id} style={{ minHeight: "120px" }}>
						<Link href={`/orders/${order.id}`} data-testid={`order-link-${order.id}`}>
							{order.title}
						</Link>
						<button
							type="button"
							data-testid={`order-delete-${order.id}`}
							onClick={() => router.delete(`/orders/${order.id}`)}
						>
							Delete
						</button>
					</li>
				))}
			</ul>

			<InfiniteScroll data="feed" data-testid="feed-scroll">
				<ul>
					{feed.data.map((item) => (
						<li key={item.id} data-feed-id={item.id}>
							{item.label}
						</li>
					))}
				</ul>
			</InfiniteScroll>
		</>
	);
}

Index.layout = layout;
