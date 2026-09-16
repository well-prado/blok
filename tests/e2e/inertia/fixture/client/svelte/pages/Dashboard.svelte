<script module lang="ts">
export { default as layout } from "../components/Layout.svelte";
</script>

<script lang="ts">
/**
 * The deferred / partial / polling page.
 *
 * `stats` (Python, group `default`) and `secondary` + `flaky` (group
 * `secondary`) are announced on the full visit and fetched in TWO parallel
 * follow-up requests. `flaky` fails the first time and is rescued, so the
 * `<Deferred>` `rescue` snippet renders and the Retry button reloads just that
 * prop.
 */
import { Deferred, InfiniteScroll, WhenVisible, router, usePoll } from "@inertiajs/svelte";
import { pageTitle } from "../title.js";

interface Props {
	auth: { id: string; email: string };
	orders: { data: { id: string; title: string }[]; total: number };
	stats?: { revenue: number; orders: number; calls: number };
	secondary?: { label: string };
	flaky?: { label: string };
	plans?: { id: string; price: number }[];
	visible?: { seen: boolean };
	feed: { data: { id: string; label: string }[]; total: number };
	users: { data: { id: string; name: string }[] };
}

const { auth, orders, stats, secondary, flaky, plans, visible, feed, users }: Props = $props();

// Scenario 38: about four requests in two seconds, each a partial naming
// `orders` — not a full page reload.
usePoll(500, { only: ["orders"] });
</script>

<svelte:head>
	<title>{pageTitle("Dashboard")}</title>
</svelte:head>

<h1 data-testid="page-heading">Dashboard</h1>
<p data-testid="auth-email-page">{auth.email}</p>
<p data-testid="orders-total">{orders.total}</p>
<ul data-plans data-testid="plans">
	{#each plans ?? [] as plan (plan.id)}
		<li>{plan.id}</li>
	{/each}
</ul>
<button type="button" data-testid="plans-reload" onclick={() => router.reload({ only: ["plans"] })}>Reload plans</button>

<div data-deferred-group="default">
	<Deferred data="stats">
		{#snippet fallback()}<span data-testid="stats-loading">loading</span>{/snippet}
		<p data-testid="stats">python revenue {stats?.revenue} calls {stats?.calls}</p>
	</Deferred>
</div>

<div data-deferred-group="secondary">
	<Deferred data="secondary">
		{#snippet fallback()}<span data-testid="secondary-loading">loading</span>{/snippet}
		<p data-testid="secondary">{secondary?.label}</p>
	</Deferred>
	<Deferred data="flaky">
		{#snippet fallback()}<span data-testid="flaky-loading">loading</span>{/snippet}
		{#snippet rescue()}<span data-testid="flaky-rescued">rescued</span>{/snippet}
		<p data-rescued="flaky" data-testid="flaky">{flaky?.label}</p>
	</Deferred>
	<button
		type="button"
		data-testid="flaky-retry"
		onclick={() => router.reload({ only: ["flaky"], data: { retry: "1" } })}
	>
		Retry
	</button>
</div>

<!--
	Scenario 39: the partial for `visible` must not leave until this block scrolls
	into view, so it sits below a tall spacer.
-->
<div style="height:2000px" data-testid="spacer"></div>
<div data-when-visible="visible">
	<WhenVisible data="visible">
		{#snippet fallback()}<span data-testid="visible-loading">loading</span>{/snippet}
		<p data-testid="visible">{visible?.seen === true ? "seen" : ""}</p>
	</WhenVisible>
</div>

<!-- Scenario 23: two infinite scrolls, two independent page parameters. -->
<InfiniteScroll data="feed" data-infinite-scroll="feed">
	<ul>
		{#each feed.data as item (item.id)}
			<li data-feed-id={item.id}>{item.label}</li>
		{/each}
	</ul>
</InfiniteScroll>
<InfiniteScroll data="users" data-infinite-scroll="users">
	<ul>
		{#each users.data as user (user.id)}
			<li data-user-id={user.id}>{user.name}</li>
		{/each}
	</ul>
</InfiniteScroll>
