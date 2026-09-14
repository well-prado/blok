<script lang="ts">
import type { PageProps } from "@blokjs/inertia";
import { Deferred, InfiniteScroll } from "@inertiajs/svelte";
import type { Dashboard } from "../../../src/workflows/dashboard.js";

// The page contract types the stock Svelte props — no Blok wrapper component.
const { auth, orders, stats, posts }: PageProps<typeof Dashboard> = $props();
</script>

<main>
  <h1>{auth.email}</h1>

  <ul>
    {#each orders as order (order.id)}
      <li>{order.sku} — {order.total}</li>
    {/each}
  </ul>

  <Deferred data="stats">
    {#snippet fallback()}
      <p>Loading stats…</p>
    {/snippet}
    <p>Revenue: {stats?.revenue}</p>
  </Deferred>

  <InfiniteScroll data="posts">
    {#each posts.data as post (post.id)}
      <p>{post.title}</p>
    {/each}
  </InfiniteScroll>
</main>
