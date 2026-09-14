<script setup lang="ts">
import type { PageProps } from "@blokjs/inertia";
import { Deferred, InfiniteScroll } from "@inertiajs/vue3";
import type { Dashboard } from "../../../src/workflows/dashboard.js";

// The page contract types the stock macro — no Blok wrapper component.
const props = defineProps<PageProps<typeof Dashboard>>();
</script>

<template>
  <main>
    <h1>{{ props.auth.email }}</h1>

    <ul>
      <li v-for="order in props.orders" :key="order.id">{{ order.sku }} — {{ order.total }}</li>
    </ul>

    <Deferred data="stats">
      <template #fallback><p>Loading stats…</p></template>
      <p>Revenue: {{ props.stats?.revenue }}</p>
    </Deferred>

    <InfiniteScroll data="posts">
      <p v-for="post in props.posts.data" :key="post.id">{{ post.title }}</p>
    </InfiniteScroll>
  </main>
</template>
