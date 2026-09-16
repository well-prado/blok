<script module lang="ts">
export { default as layout } from "../../components/Layout.svelte";
</script>

<script lang="ts">
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
import { Link, page, useForm, useRemember } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

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
let peak = $state(0);

// Scenario 40: history-backed state. `useForm`'s precognitive overload takes no
// remember key, so the remembered field is its own `useRemember`.
const note = useRemember({ value: "" }, "orders-create-note");

function messages(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? (value as string[]) : [String(value)];
}

const skuErrors = $derived(messages((page.props.errors as Record<string, unknown> | undefined)?.sku));
</script>

<svelte:head>
	<title>{pageTitle("New order")}</title>
</svelte:head>

<h1 data-testid="page-heading">New order</h1>

<form
	data-testid="form-create"
	onsubmit={(event) => {
		event.preventDefault();
		form.post("/orders");
	}}
>
	<label for="sku">SKU</label>
	<input id="sku" data-testid="sku" bind:value={form.sku} onblur={() => form.validate("sku")} />
	<label for="qty">Qty</label>
	<input
		id="qty"
		data-testid="qty"
		value={String(form.qty)}
		oninput={(event) => {
			form.qty = Number(event.currentTarget.value) || 0;
		}}
	/>
	{#each skuErrors as message (message)}
		<span data-error-message data-testid="error-sku">{message}</span>
	{/each}
	<button type="submit" data-testid="submit-create">Create</button>
</form>

<form
	data-testid="form-bag-a"
	onsubmit={(event) => {
		event.preventDefault();
		bagA.post("/orders", { errorBag: "bagA" });
	}}
>
	<input data-testid="bag-a-sku" bind:value={bagA.sku} />
	{#each messages(bagA.errors.sku) as message (message)}
		<span data-testid="bag-a-error">{message}</span>
	{/each}
	<button type="submit" data-testid="submit-bag-a">Submit A</button>
</form>

<form
	data-testid="form-bag-b"
	onsubmit={(event) => {
		event.preventDefault();
		bagB.post("/orders", { errorBag: "bagB" });
	}}
>
	<input data-testid="bag-b-sku" bind:value={bagB.sku} />
	{#each messages(bagB.errors.sku) as message (message)}
		<span data-testid="bag-b-error">{message}</span>
	{/each}
	<button type="submit" data-testid="submit-bag-b">Submit B</button>
</form>

<form
	data-testid="form-upload"
	onsubmit={(event) => {
		event.preventDefault();
		upload.post("/orders/upload", {
			forceFormData: true,
			onProgress: (progress) => {
				peak = Math.max(peak, progress?.percentage ?? 0);
			},
			onSuccess: () => {
				peak = 100;
			},
		});
	}}
>
	<input
		type="file"
		data-testid="proof"
		onchange={(event) => {
			upload.proof = event.currentTarget.files?.[0] ?? null;
		}}
	/>
	<div role="progressbar" data-testid="upload-progress" aria-valuenow={peak} aria-valuemin={0} aria-valuemax={100}>
		{peak}
	</div>
	<button type="submit" data-testid="submit-upload">Upload</button>
</form>

<label for="note">Note</label>
<input id="note" data-testid="remember-note" bind:value={note.value} />

<Link href="/orders" data-testid="orders-link">Back to orders</Link>
