<script setup lang="ts">
/**
 * The list page: every partial-reload mode on one screen.
 *
 * `orders` is a `merge()` prop (append + match on `id`), `feed` a `scroll()`
 * prop, `filters` an `optional()` prop and `plans` a `once()` prop — so the
 * buttons below drive scenarios 9, 21, 22, 24 and 25 against real requests
 * rather than a mocked router.
 */
import { Head, InfiniteScroll, Link, router } from "@inertiajs/vue3";
import Layout from "../../components/Layout.vue";

interface Order {
	id: string;
	sku: string;
	title: string;
	qty: number;
}

defineProps<{
	orders: { data: Order[]; total: number };
	filters?: { status: string };
	plans: { id: string; price: number }[];
	feed: { data: { id: string; label: string }[]; total: number };
}>();

defineOptions({ layout: Layout });
</script>

<template>
	<Head title="Orders" />
	<h1 data-testid="page-heading">Orders</h1>

	<p data-testid="orders-total">{{ orders.total }}</p>

	<div>
		<button type="button" data-testid="orders-reload" @click="router.reload({ only: ['orders'] })">
			Reload orders
		</button>
		<button type="button" data-testid="orders-except" @click="router.reload({ except: ['orders'] })">
			Reload except orders
		</button>
		<button
			type="button"
			data-testid="orders-more"
			@click="router.reload({ only: ['orders'], data: { page: '2' } })"
		>
			Load more
		</button>
		<button
			type="button"
			data-testid="orders-update"
			@click="router.reload({ only: ['orders'], data: { bump: '1' } })"
		>
			Update existing
		</button>
		<button type="button" data-testid="filters-load" @click="router.reload({ only: ['filters'] })">
			Load filters
		</button>
		<button type="button" data-testid="plans-reload" @click="router.reload({ only: ['plans'] })">Reload plans</button>
		<button type="button" data-testid="feed-more" @click="router.reload({ only: ['feed'], data: { feed: '2' } })">
			More feed
		</button>
		<button
			type="button"
			data-testid="feed-reset"
			@click="router.visit('/orders', { only: ['feed'], reset: ['feed'], preserveState: true })"
		>
			Reset feed
		</button>
	</div>

	<div>
		<Link href="/orders/create" data-testid="orders-create-link">New order</Link>
		<Link href="/__e2e/external" data-testid="external-link">External</Link>
		<Link href="/__e2e/fragment" data-testid="fragment-link">Fragment</Link>
	</div>

	<p v-if="filters" data-filters data-testid="filters">{{ filters.status }}</p>
	<ul v-if="plans" data-plans data-testid="plans">
		<li v-for="plan in plans" :key="plan.id">{{ plan.id }}</li>
	</ul>

	<ul>
		<!--
			Tall rows on purpose: scenario 4 scrolls past 600px before it
			navigates, and a short list would never leave the fold.
		-->
		<li
			v-for="order in orders.data"
			:key="order.id"
			:data-order-id="order.id"
			style="min-height: 120px"
		>
			<Link :href="`/orders/${order.id}`" :data-testid="`order-link-${order.id}`">{{ order.title }}</Link>
			<button
				type="button"
				:data-testid="`order-delete-${order.id}`"
				@click="router.delete(`/orders/${order.id}`)"
			>
				Delete
			</button>
		</li>
	</ul>

	<InfiniteScroll data="feed" data-testid="feed-scroll">
		<ul>
			<li v-for="item in feed.data" :key="item.id" :data-feed-id="item.id">{{ item.label }}</li>
		</ul>
	</InfiniteScroll>
</template>
