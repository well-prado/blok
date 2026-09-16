<script setup lang="ts">
import { Head } from "@inertiajs/vue3";
import Layout from "../../components/Layout.vue";

const props = defineProps<{ order: { id: string; sku: string; title: string; qty: number } }>();

defineOptions({ layout: Layout });
</script>

<template>
	<Head :title="`Order ${props.order.id}`" />
	<h1 data-testid="page-heading">Order {{ order.id }}</h1>
	<p data-testid="order-sku">{{ order.sku }}</p>
</template>
