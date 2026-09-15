import { Head, Link, useForm, usePage, useRemember } from "@inertiajs/react";
import { useState } from "react";
import { layout } from "../../components/Layout.js";

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
export default function Create() {
	const { props } = usePage<{ errors: Record<string, string | string[]> }>();
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
	const [peak, setPeak] = useState(0);
	// Scenario 40: history-backed state. `useForm`'s precognitive overload takes
	// no remember key, so the remembered field is its own `useRemember`.
	const [note, setNote] = useRemember("", "orders-create-note");

	const messages = (value: string | string[] | undefined): string[] =>
		value === undefined ? [] : Array.isArray(value) ? value : [value];

	return (
		<>
			<Head title="New order" />
			<h1 data-testid="page-heading">New order</h1>

			<form
				data-testid="form-create"
				onSubmit={(event) => {
					event.preventDefault();
					form.post("/orders");
				}}
			>
				<label htmlFor="sku">SKU</label>
				<input
					id="sku"
					data-testid="sku"
					value={form.data.sku}
					onChange={(event) => form.setData("sku", event.target.value)}
					onBlur={() => form.validate("sku")}
				/>
				<label htmlFor="qty">Qty</label>
				<input
					id="qty"
					data-testid="qty"
					value={String(form.data.qty)}
					onChange={(event) => form.setData("qty", Number(event.target.value) || 0)}
				/>
				{messages(props.errors.sku).map((message) => (
					<span key={message} data-error-message data-testid="error-sku">
						{message}
					</span>
				))}
				<button type="submit" data-testid="submit-create">
					Create
				</button>
			</form>

			<form
				data-testid="form-bag-a"
				onSubmit={(event) => {
					event.preventDefault();
					bagA.post("/orders", { errorBag: "bagA" });
				}}
			>
				<input data-testid="bag-a-sku" value={bagA.data.sku} onChange={(e) => bagA.setData("sku", e.target.value)} />
				{messages(bagA.errors.sku).map((message) => (
					<span key={message} data-testid="bag-a-error">
						{message}
					</span>
				))}
				<button type="submit" data-testid="submit-bag-a">
					Submit A
				</button>
			</form>

			<form
				data-testid="form-bag-b"
				onSubmit={(event) => {
					event.preventDefault();
					bagB.post("/orders", { errorBag: "bagB" });
				}}
			>
				<input data-testid="bag-b-sku" value={bagB.data.sku} onChange={(e) => bagB.setData("sku", e.target.value)} />
				{messages(bagB.errors.sku).map((message) => (
					<span key={message} data-testid="bag-b-error">
						{message}
					</span>
				))}
				<button type="submit" data-testid="submit-bag-b">
					Submit B
				</button>
			</form>

			<form
				data-testid="form-upload"
				onSubmit={(event) => {
					event.preventDefault();
					upload.post("/orders/upload", {
						forceFormData: true,
						onProgress: (progress) => setPeak((current) => Math.max(current, progress?.percentage ?? 0)),
						onSuccess: () => setPeak(100),
					});
				}}
			>
				<input
					type="file"
					data-testid="proof"
					onChange={(event) => upload.setData("proof", event.target.files?.[0] ?? null)}
				/>
				<div
					role="progressbar"
					tabIndex={0}
					data-testid="upload-progress"
					aria-valuenow={peak}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					{peak}
				</div>
				<button type="submit" data-testid="submit-upload">
					Upload
				</button>
			</form>

			<label htmlFor="note">Note</label>
			<input id="note" data-testid="remember-note" value={note} onChange={(event) => setNote(event.target.value)} />

			<Link href="/orders" data-testid="orders-link">
				Back to orders
			</Link>
		</>
	);
}

Create.layout = layout;
