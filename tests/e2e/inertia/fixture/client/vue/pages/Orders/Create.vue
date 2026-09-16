<script setup lang="ts">
/**
 * The form page — scenarios 5, 6, 11, 27 through 32, and 40.
 *
 * THREE forms on one page, on purpose:
 *  - `form-create` is the ordinary submit (and, through `validate()`, the
 *    Precognition probe);
 *  - `form-bag-a` / `form-bag-b` post the SAME field name under two error bags,
 *    which is what keeps their errors independent (scenario 28);
 *  - `form-upload` posts multipart with `_method: put` spoofing (scenario 31).
 *
 * `useForm("post", url, data)` is the precognitive overload: `form.validate()`
 * sends `Precognition: true` and the runner answers from the `{ precognition:
 * true }` step alone.
 */
import { Head, Link, useForm, usePage, useRemember } from "@inertiajs/vue3";
import { type Ref, ref } from "vue";
import Layout from "../../components/Layout.vue";

const page = usePage<{ errors: Record<string, string | string[]> }>();
const form = useForm("post", "/orders", { sku: "", qty: 1 });
const bagA = useForm({ sku: "" });
const bagB = useForm({ sku: "" });
const upload = useForm<{ sku: string; proof: File | null; _method: string }>({
	sku: "spoofed",
	proof: null,
	_method: "put",
});
// `form.progress` is null again once the upload settles, so the peak is what
// proves it reached 100 — a live read would be a race with the assertion.
const peak = ref(0);
// Scenario 40: history-backed state. `useForm`'s precognitive overload takes no
// remember key, so the remembered field is its own `useRemember` — which in Vue
// remembers an OBJECT, never a bare string.
const remembered = useRemember({ note: "" }, "orders-create-note") as Ref<{ note: string }>;

defineOptions({ layout: Layout });

function messages(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function pickProof(event: Event): void {
	upload.proof = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function submitUpload(): void {
	upload.post("/orders/upload", {
		forceFormData: true,
		onProgress: (progress) => {
			peak.value = Math.max(peak.value, progress?.percentage ?? 0);
		},
		onSuccess: () => {
			peak.value = 100;
		},
	});
}
</script>

<template>
	<Head title="New order" />
	<h1 data-testid="page-heading">New order</h1>

	<form data-testid="form-create" @submit.prevent="form.post('/orders')">
		<label for="sku">SKU</label>
		<input id="sku" v-model="form.sku" data-testid="sku" @blur="form.validate('sku')" />
		<label for="qty">Qty</label>
		<input id="qty" v-model.number="form.qty" data-testid="qty" />
		<span
			v-for="message in messages(page.props.errors.sku)"
			:key="message"
			data-error-message
			data-testid="error-sku"
			>{{ message }}</span
		>
		<button type="submit" data-testid="submit-create">Create</button>
	</form>

	<form data-testid="form-bag-a" @submit.prevent="bagA.post('/orders', { errorBag: 'bagA' })">
		<input v-model="bagA.sku" data-testid="bag-a-sku" />
		<span v-for="message in messages(bagA.errors.sku)" :key="message" data-testid="bag-a-error">{{ message }}</span>
		<button type="submit" data-testid="submit-bag-a">Submit A</button>
	</form>

	<form data-testid="form-bag-b" @submit.prevent="bagB.post('/orders', { errorBag: 'bagB' })">
		<input v-model="bagB.sku" data-testid="bag-b-sku" />
		<span v-for="message in messages(bagB.errors.sku)" :key="message" data-testid="bag-b-error">{{ message }}</span>
		<button type="submit" data-testid="submit-bag-b">Submit B</button>
	</form>

	<form data-testid="form-upload" @submit.prevent="submitUpload">
		<input type="file" data-testid="proof" @change="pickProof" />
		<div
			role="progressbar"
			data-testid="upload-progress"
			:aria-valuenow="peak"
			aria-valuemin="0"
			aria-valuemax="100"
		>
			{{ peak }}
		</div>
		<button type="submit" data-testid="submit-upload">Upload</button>
	</form>

	<label for="note">Note</label>
	<input id="note" v-model="remembered.note" data-testid="remember-note" />

	<Link href="/orders" data-testid="orders-link">Back to orders</Link>
</template>
