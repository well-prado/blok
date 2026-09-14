<script setup lang="ts">
import type { PageProps } from "@blokjs/inertia";
import { Deferred, Head, InfiniteScroll } from "@inertiajs/vue3";
import { computed } from "vue";
import type { Dashboard } from "../../../src/workflows/dashboard.js";
import AppLayout from "../components/AppLayout.vue";

// The page contract types the stock macro — no Blok wrapper component.
const props = defineProps<PageProps<typeof Dashboard>>();

// Inertia keeps the layout MOUNTED across visits; only this page swaps.
defineOptions({ layout: AppLayout });

const orderValue = computed(() => props.orders.reduce((sum, order) => sum + order.total, 0));
</script>

<template>
	<Head title="Dashboard" />

	<div class="blok-page-header">
		<div>
			<p class="blok-eyebrow">Inertia · Vue 3</p>
			<h1>Dashboard</h1>
			<p class="blok-lede">The same page contract as the React example, rendered by a Vue client.</p>
		</div>
	</div>

	<div class="blok-stats">
		<div class="blok-stat">
			<p class="blok-stat__label">Revenue</p>
			<Deferred data="stats">
				<template #fallback>
					<div class="blok-skeleton blok-skeleton--wide" style="height: 1.75rem" />
					<div class="blok-skeleton" style="width: 40%" />
				</template>
				<p class="blok-stat__value">${{ props.stats?.revenue }}</p>
				<p class="blok-stat__delta blok-stat__delta--up">defer() · fetched after the first paint</p>
			</Deferred>
		</div>
		<div class="blok-stat">
			<p class="blok-stat__label">Orders</p>
			<p class="blok-stat__value">{{ props.orders.length }}</p>
			<p class="blok-stat__delta">regular prop</p>
		</div>
		<div class="blok-stat">
			<p class="blok-stat__label">Order value</p>
			<p class="blok-stat__value">${{ orderValue }}</p>
			<p class="blok-stat__delta blok-stat__delta--up">derived on the client</p>
		</div>
		<div class="blok-stat">
			<p class="blok-stat__label">Posts</p>
			<p class="blok-stat__value">{{ props.posts.total }}</p>
			<p class="blok-stat__delta">scroll() · {{ props.posts.perPage }} per page</p>
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
					<tr v-for="order in props.orders" :key="order.id">
						<td>
							<code>{{ order.id }}</code>
						</td>
						<td>{{ order.sku }}</td>
						<td class="blok-num">${{ order.total }}</td>
					</tr>
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
				<li v-for="post in props.posts.data" :key="post.id">
					<span>{{ post.title }}</span>
					<span class="blok-feed__meta">{{ post.id }}</span>
				</li>
			</ul>
			<template #loading>
				<p class="blok-end-of-list"><span class="blok-spinner" /> Loading more posts…</p>
			</template>
			<template #next="{ hasMore }">
				<p v-if="!hasMore" class="blok-end-of-list">That is all {{ props.posts.total }} posts.</p>
			</template>
		</InfiniteScroll>
	</div>
</template>
