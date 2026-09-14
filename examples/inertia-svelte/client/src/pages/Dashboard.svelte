<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../components/AppLayout.svelte";
</script>

<script lang="ts">
import type { PageProps } from "@blokjs/inertia";
import { Deferred, InfiniteScroll } from "@inertiajs/svelte";
import type { Dashboard } from "../../../src/workflows/dashboard.js";

// The page contract types the stock Svelte props — no Blok wrapper component.
const { orders, stats, posts }: PageProps<typeof Dashboard> = $props();

const orderValue = $derived(orders.reduce((sum, order) => sum + order.total, 0));
</script>

<svelte:head>
	<title>Dashboard · Blok</title>
</svelte:head>

<div class="blok-page-header">
	<div>
		<p class="blok-eyebrow">Inertia · Svelte 5</p>
		<h1>Dashboard</h1>
		<p class="blok-lede">The same page contract as the React example, rendered by a Svelte client.</p>
	</div>
</div>

<div class="blok-stats">
	<div class="blok-stat">
		<p class="blok-stat__label">Revenue</p>
		<Deferred data="stats">
			{#snippet fallback()}
				<div class="blok-skeleton blok-skeleton--wide" style="height: 1.75rem"></div>
				<div class="blok-skeleton" style="width: 40%"></div>
			{/snippet}
			<p class="blok-stat__value">${stats?.revenue}</p>
			<p class="blok-stat__delta blok-stat__delta--up">defer() · fetched after the first paint</p>
		</Deferred>
	</div>
	<div class="blok-stat">
		<p class="blok-stat__label">Orders</p>
		<p class="blok-stat__value">{orders.length}</p>
		<p class="blok-stat__delta">regular prop</p>
	</div>
	<div class="blok-stat">
		<p class="blok-stat__label">Order value</p>
		<p class="blok-stat__value">${orderValue}</p>
		<p class="blok-stat__delta blok-stat__delta--up">derived on the client</p>
	</div>
	<div class="blok-stat">
		<p class="blok-stat__label">Posts</p>
		<p class="blok-stat__value">{posts.total}</p>
		<p class="blok-stat__delta">scroll() · {posts.perPage} per page</p>
	</div>
</div>

<div class="blok-card">
	<div class="blok-card__header">
		<h2>Orders</h2>
		<span class="blok-badge">regular</span>
	</div>
	<div class="blok-table-wrap">
		<table class="blok-table">
			<thead>
				<tr>
					<th scope="col">Order</th>
					<th scope="col">SKU</th>
					<th scope="col" class="blok-num">Total</th>
				</tr>
			</thead>
			<tbody>
				{#each orders as order (order.id)}
					<tr>
						<td><code>{order.id}</code></td>
						<td>{order.sku}</td>
						<td class="blok-num">${order.total}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<div class="blok-card">
	<div class="blok-card__header">
		<h2>Posts</h2>
		<span class="blok-badge">infinite scroll</span>
	</div>
	<InfiniteScroll data="posts">
		<ul class="blok-feed">
			{#each posts.data as post (post.id)}
				<li>
					<span>{post.title}</span>
					<span class="blok-feed__meta">{post.id}</span>
				</li>
			{/each}
		</ul>
		{#snippet loading()}
			<p class="blok-end-of-list"><span class="blok-spinner"></span> Loading more posts…</p>
		{/snippet}
		{#snippet next({ hasMore })}
			{#if !hasMore}
				<p class="blok-end-of-list">That is all {posts.total} posts.</p>
			{/if}
		{/snippet}
	</InfiniteScroll>
</div>
