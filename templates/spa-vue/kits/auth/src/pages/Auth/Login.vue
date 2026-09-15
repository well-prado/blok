<script setup lang="ts">
/**
 * `Auth/Login` — the sign-in form (#1018).
 *
 * An ordinary Inertia form posting to the kit's `POST /login` workflow.
 * Everything Blok-specific is on the server: `@blokjs/validate` checks the
 * body, `@blokjs/auth`'s `login` node verifies the password (throttled per
 * IP + email), starts a fresh session and answers 303. A failure redirects
 * back with `props.errors.email` — which is what `form.errors.email` reads.
 */
import { Head, Link, useForm } from "@inertiajs/vue3";
import GuestLayout from "../../components/GuestLayout.vue";

defineOptions({ layout: GuestLayout });

const form = useForm("post", "/login", { email: "", password: "", remember: false });

function submit(): void {
	form.post("/login", { onFinish: () => form.reset("password") });
}
</script>

<template>
	<Head title="Sign in" />

	<h1>Sign in</h1>
	<p class="blok-lede">Welcome back.</p>

	<form class="blok-form" @submit.prevent="submit">
		<div class="blok-field">
			<label class="blok-label" for="email">Email</label>
			<input
				id="email"
				v-model="form.email"
				name="email"
				type="email"
				autocomplete="username"
				class="blok-input"
				placeholder="you@example.com"
				:aria-invalid="form.errors.email ? true : undefined"
				:aria-describedby="form.errors.email ? 'email-error' : undefined"
			/>
			<p v-if="form.errors.email" id="email-error" class="blok-error">{{ form.errors.email }}</p>
		</div>

		<div class="blok-field">
			<label class="blok-label" for="password">Password</label>
			<input
				id="password"
				v-model="form.password"
				name="password"
				type="password"
				autocomplete="current-password"
				class="blok-input"
				:aria-invalid="form.errors.password ? true : undefined"
				:aria-describedby="form.errors.password ? 'password-error' : undefined"
			/>
			<p v-if="form.errors.password" id="password-error" class="blok-error">{{ form.errors.password }}</p>
		</div>

		<div class="blok-guest__row">
			<label class="blok-check" for="remember">
				<input id="remember" v-model="form.remember" name="remember" type="checkbox" />
				Remember me
			</label>
			<Link href="/forgot-password">Forgot your password?</Link>
		</div>

		<div class="blok-form__actions">
			<button type="submit" class="blok-btn blok-btn--primary" :disabled="form.processing">
				<span v-if="form.processing" class="blok-spinner" />
				{{ form.processing ? "Signing in…" : "Sign in" }}
			</button>
			<Link href="/register" class="blok-btn">Create an account</Link>
		</div>
	</form>
</template>
