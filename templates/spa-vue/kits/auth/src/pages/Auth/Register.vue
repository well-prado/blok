<script setup lang="ts">
/**
 * `Auth/Register` — create an account (#1018).
 *
 * The field names are the kit's `RegisterSchema` (`@blokjs/auth`): rename one
 * here and the server's error keys stop matching. Success starts a session and
 * lands on `/dashboard`; a duplicate address comes back as `errors.email`.
 */
import { Head, Link, useForm } from "@inertiajs/vue3";
import GuestLayout from "../../components/GuestLayout.vue";

defineOptions({ layout: GuestLayout });

const form = useForm("post", "/register", {
	name: "",
	email: "",
	password: "",
	passwordConfirmation: "",
});

function submit(): void {
	form.post("/register", { onFinish: () => form.reset("password", "passwordConfirmation") });
}
</script>

<template>
	<Head title="Create an account" />

	<h1>Create an account</h1>
	<p class="blok-lede">Takes a moment. No email confirmation in the scaffold.</p>

	<form class="blok-form" @submit.prevent="submit">
		<div class="blok-field">
			<label class="blok-label" for="name">Name</label>
			<input
				id="name"
				v-model="form.name"
				name="name"
				autocomplete="name"
				class="blok-input"
				:aria-invalid="form.errors.name ? true : undefined"
				:aria-describedby="form.errors.name ? 'name-error' : undefined"
			/>
			<p v-if="form.errors.name" id="name-error" class="blok-error">{{ form.errors.name }}</p>
		</div>

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
				autocomplete="new-password"
				class="blok-input"
				:aria-invalid="form.errors.password ? true : undefined"
				:aria-describedby="form.errors.password ? 'password-error' : 'password-hint'"
			/>
			<p v-if="form.errors.password" id="password-error" class="blok-error">{{ form.errors.password }}</p>
			<p v-else id="password-hint" class="blok-hint">At least 8 characters.</p>
		</div>

		<div class="blok-field">
			<label class="blok-label" for="passwordConfirmation">Confirm password</label>
			<input
				id="passwordConfirmation"
				v-model="form.passwordConfirmation"
				name="passwordConfirmation"
				type="password"
				autocomplete="new-password"
				class="blok-input"
				:aria-invalid="form.errors.passwordConfirmation ? true : undefined"
				:aria-describedby="form.errors.passwordConfirmation ? 'confirm-error' : undefined"
			/>
			<p v-if="form.errors.passwordConfirmation" id="confirm-error" class="blok-error">
				{{ form.errors.passwordConfirmation }}
			</p>
		</div>

		<div class="blok-form__actions">
			<button type="submit" class="blok-btn blok-btn--primary" :disabled="form.processing">
				<span v-if="form.processing" class="blok-spinner" />
				{{ form.processing ? "Creating…" : "Create account" }}
			</button>
			<Link href="/login" class="blok-btn">I already have one</Link>
		</div>
	</form>
</template>
