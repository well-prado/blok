<script setup lang="ts">
import { Head, useForm } from "@inertiajs/vue3";
import Layout from "../components/Layout.vue";

const form = useForm({ email: "", password: "", to: "/secret" });

defineOptions({ layout: Layout });
</script>

<template>
	<Head title="Login" />
	<h1 data-testid="page-heading">Login</h1>
	<form data-testid="form-login" @submit.prevent="form.post('/login')">
		<label for="email">Email</label>
		<input id="email" v-model="form.email" data-testid="email" />
		<label for="password">Password</label>
		<input id="password" v-model="form.password" type="password" data-testid="password" />
		<button type="submit" data-testid="submit-login">Sign in</button>
	</form>
</template>
