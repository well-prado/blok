<script setup lang="ts">
/**
 * `Auth/ResetPassword` — choose a new password (#1018).
 *
 * `reset` is a real page prop: the `:token` from the URL, echoed by the kit's
 * `resetToken` node so the form can post it back. The token is single-use and
 * expires; the server checks it when it is SPENT, never here.
 *
 * ponytail: `usePage<PageProps<…>>()` rather than `defineProps<PageProps<…>>()`
 * — @vue/compiler-sfc resolves prop TYPES with its own resolver and cannot
 * follow the generic indexed access inside `PageProps` (same note as `Home`).
 */
import type { PageProps } from "@blokjs/inertia-client";
import { Head, Link, useForm, usePage } from "@inertiajs/vue3";
import GuestLayout from "../../components/GuestLayout.vue";

defineOptions({ layout: GuestLayout });

const page = usePage<PageProps<"Auth/ResetPassword">>();
const url = `/reset-password/${page.props.reset.token}`;

const form = useForm("post", url, {
	token: page.props.reset.token,
	email: page.props.reset.email ?? "",
	password: "",
	passwordConfirmation: "",
});

function submit(): void {
	form.post(url, { onFinish: () => form.reset("password", "passwordConfirmation") });
}
</script>

<template>
	<Head title="Choose a new password" />

	<h1>Choose a new password</h1>
	<p class="blok-lede">This link works once.</p>

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
				:aria-invalid="form.errors.email ? true : undefined"
				:aria-describedby="form.errors.email ? 'email-error' : undefined"
			/>
			<p v-if="form.errors.email" id="email-error" class="blok-error">{{ form.errors.email }}</p>
		</div>

		<div class="blok-field">
			<label class="blok-label" for="password">New password</label>
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
			<label class="blok-label" for="passwordConfirmation">Confirm new password</label>
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
				{{ form.processing ? "Saving…" : "Reset password" }}
			</button>
			<Link href="/login" class="blok-btn">Back to sign in</Link>
		</div>
	</form>
</template>
