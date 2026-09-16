<script module lang="ts">
export { default as layout } from "../../components/Layout.svelte";
</script>

<script lang="ts">
import { pageTitle } from "../../title.js";

const { order }: { order: { id: string; sku: string; title: string; qty: number } } = $props();
</script>

<svelte:head>
	<title>{pageTitle(`Order ${order.id}`)}</title>
</svelte:head>

<h1 data-testid="page-heading">Order {order.id}</h1>
<p data-testid="order-sku">{order.sku}</p>
