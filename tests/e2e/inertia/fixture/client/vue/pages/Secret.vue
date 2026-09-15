<script setup lang="ts">
import { Head, router } from "@inertiajs/vue3";
import Layout from "../components/Layout.vue";

defineProps<{ auth: { id: string; email: string } }>();

defineOptions({ layout: Layout });
</script>

<template>
	<Head title="Secret" />
	<h1 data-testid="page-heading">Secret</h1>
	<p data-testid="secret-email">{{ auth.email }}</p>
	<button type="button" data-testid="logout" @click="router.post('/logout')">Logout</button>
</template>
