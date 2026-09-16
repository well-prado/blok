<script setup lang="ts">
/** The production error page: a real Inertia response carrying a 4xx/5xx status. */
import { Head } from "@inertiajs/vue3";
import Layout from "../../components/Layout.vue";

const props = defineProps<{ status: number; message: string }>();

defineOptions({ layout: Layout });
</script>

<template>
	<Head :title="String(props.status)" />
	<h1 data-testid="page-heading">{{ status }} — {{ message }}</h1>
</template>
