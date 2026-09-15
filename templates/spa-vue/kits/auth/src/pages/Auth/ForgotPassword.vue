<script setup lang="ts">
/**
 * `Auth/ForgotPassword` — ask for a reset link (#1018).
 *
 * The server answers the SAME way whether or not the address exists (anything
 * else turns this form into an account-enumeration oracle), so there is no
 * success/failure branch to render: the neutral message arrives as flash and
 * `flash-toast.ts` shows it.
 *
 * With no mailer configured the kit LOGS the link — look in the Blok server's
 * output, then `configureAuth({ sendResetLink })` to send it for real.
 */
import { Head, Link, useForm } from "@inertiajs/vue3";
import GuestLayout from "../../components/GuestLayout.vue";

defineOptions({ layout: GuestLayout });

const form = useForm("post", "/forgot-password", { email: "" });
</script>

<template>
	<Head title="Forgot your password?" />

	<h1>Forgot your password?</h1>
	<p class="blok-lede">We will email you a link to choose a new one.</p>

	<form class="blok-form" @submit.prevent="form.post('/forgot-password')">
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

		<div class="blok-form__actions">
			<button type="submit" class="blok-btn blok-btn--primary" :disabled="form.processing">
				<span v-if="form.processing" class="blok-spinner" />
				{{ form.processing ? "Sending…" : "Email the link" }}
			</button>
			<Link href="/login" class="blok-btn">Back to sign in</Link>
		</div>
	</form>
</template>
