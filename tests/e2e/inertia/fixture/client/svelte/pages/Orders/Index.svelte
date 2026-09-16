<script module lang="ts">
export { default as layout } from "../../components/Layout.svelte";
</script>

<script lang="ts">
/**
 * The list page: every partial-reload mode on one screen.
 *
 * `orders` is a `merge()` prop (append + match on `id`), `feed` a `scroll()`
 * prop, `filters` an `optional()` prop and `plans` a `once()` prop — so the
 * buttons below drive scenarios 9, 21, 22, 24 and 25 against real requests
 * rather than a mocked router.
 */
import { InfiniteScroll, Link, router } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

interface Order {
	id: string;
	sku: string;
	title: string;
	qty: number;
}

interface Props {
	orders: { data: Order[]; total: number };
	filters?: { status: string };
	plans?: { id: string; price: number }[];
	feed: { data: { id: string; label: string }[]; total: number };
}

const { orders, filters, plans, feed }: Props = $props();
</script>

<svelte:head>
	<title>{pageTitle("Orders")}</title>
</svelte:head>

<h1 data-testid="page-heading">Orders</h1>

<p data-testid="orders-total">{orders.total}</p>

<div>
	<button type="button" data-testid="orders-reload" onclick={() => router.reload({ only: ["orders"] })}>
		Reload orders
	</button>
	<button type="button" data-testid="orders-except" onclick={() => router.reload({ except: ["orders"] })}>
		Reload except orders
	</button>
	<button type="button" data-testid="orders-more" onclick={() => router.reload({ only: ["orders"], data: { page: "2" } })}>
		Load more
	</button>
	<button type="button" data-testid="orders-update" onclick={() => router.reload({ only: ["orders"], data: { bump: "1" } })}>
		Update existing
	</button>
	<button type="button" data-testid="filters-load" onclick={() => router.reload({ only: ["filters"] })}>
		Load filters
	</button>
	<button type="button" data-testid="plans-reload" onclick={() => router.reload({ only: ["plans"] })}>Reload plans</button>
	<button type="button" data-testid="feed-more" onclick={() => router.reload({ only: ["feed"], data: { feed: "2" } })}>
		More feed
	</button>
	<button
		type="button"
		data-testid="feed-reset"
		onclick={() => router.visit("/orders", { only: ["feed"], reset: ["feed"], preserveState: true })}
	>
		Reset feed
	</button>
</div>

<div>
	<Link href="/orders/create" data-testid="orders-create-link">New order</Link>
	<Link href="/__e2e/external" data-testid="external-link">External</Link>
	<Link href="/__e2e/fragment" data-testid="fragment-link">Fragment</Link>
</div>

{#if filters}
	<p data-filters data-testid="filters">{filters.status}</p>
{/if}
{#if plans}
	<ul data-plans data-testid="plans">
		{#each plans as plan (plan.id)}
			<li>{plan.id}</li>
		{/each}
	</ul>
{/if}

<ul>
	<!--
		Tall rows on purpose: scenario 4 scrolls past 600px before it navigates, and
		a short list would never leave the fold.
	-->
	{#each orders.data as order (order.id)}
		<li data-order-id={order.id} style="min-height:120px">
			<Link href={`/orders/${order.id}`} data-testid={`order-link-${order.id}`}>{order.title}</Link>
			<button type="button" data-testid={`order-delete-${order.id}`} onclick={() => router.delete(`/orders/${order.id}`)}>
				Delete
			</button>
		</li>
	{/each}
</ul>

<InfiniteScroll data="feed" data-testid="feed-scroll">
	<ul>
		{#each feed.data as item (item.id)}
			<li data-feed-id={item.id}>{item.label}</li>
		{/each}
	</ul>
</InfiniteScroll>
