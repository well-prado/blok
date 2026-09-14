import { useForm } from "@inertiajs/react";

/**
 * An ordinary Inertia form. `validateOn` drives Precognition: the keystroke
 * hits POST /orders with `Precognition: true`, the runner stops after the
 * validation step, and nothing is written.
 */
export default function Create() {
	const form = useForm({ sku: "", total: 1 });

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				form.post("/orders");
			}}
		>
			<input
				value={form.data.sku}
				onChange={(event) => form.setData("sku", event.target.value)}
				placeholder="SKU"
			/>
			{form.errors.sku ? <span>{form.errors.sku}</span> : null}

			<input
				type="number"
				value={form.data.total}
				onChange={(event) => form.setData("total", Number(event.target.value))}
			/>
			{form.errors.total ? <span>{form.errors.total}</span> : null}

			<button type="submit" disabled={form.processing}>
				Save
			</button>
		</form>
	);
}
