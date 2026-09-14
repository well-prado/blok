import { Head, Link, useForm } from "@inertiajs/react";
import { appLayout } from "../../components/AppLayout.js";

/**
 * An ordinary Inertia form. `form.validate(field)` drives Precognition: the
 * blur hits POST /orders with `Precognition: true`, the runner stops after the
 * step marked `{ precognition: true }`, and nothing is written.
 *
 * The success path is a redirect back carrying flash — `flash-toast.ts` turns
 * it into the `.blok-toast` in the corner.
 */
export default function Create() {
	const form = useForm("post", "/orders", { sku: "", total: 1 });

	return (
		<>
			<Head title="New order" />

			<div className="blok-page-header">
				<div>
					<p className="blok-eyebrow">Orders</p>
					<h1>New order</h1>
					<p className="blok-lede">Validated live by the same workflow that saves it.</p>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__body">
					<form
						className="blok-form"
						onSubmit={(event) => {
							event.preventDefault();
							form.post("/orders");
						}}
					>
						<div className="blok-field">
							<label className="blok-label" htmlFor="sku">
								SKU
							</label>
							<input
								id="sku"
								name="sku"
								className="blok-input"
								placeholder="BLOK-1"
								value={form.data.sku}
								onChange={(event) => form.setData("sku", event.target.value)}
								onBlur={() => form.validate("sku")}
								aria-invalid={form.errors.sku === undefined ? undefined : true}
								aria-describedby={form.errors.sku === undefined ? "sku-hint" : "sku-error"}
							/>
							{form.errors.sku === undefined ? (
								<p className="blok-hint" id="sku-hint">
									The product code this order is for.
								</p>
							) : (
								<p className="blok-error" id="sku-error">
									{form.errors.sku}
								</p>
							)}
						</div>

						<div className="blok-field">
							<label className="blok-label" htmlFor="total">
								Total
							</label>
							<input
								id="total"
								name="total"
								type="number"
								min={1}
								className="blok-input"
								value={form.data.total}
								onChange={(event) => form.setData("total", Number(event.target.value))}
								onBlur={() => form.validate("total")}
								aria-invalid={form.errors.total === undefined ? undefined : true}
								aria-describedby={form.errors.total === undefined ? "total-hint" : "total-error"}
							/>
							{form.errors.total === undefined ? (
								<p className="blok-hint" id="total-hint">
									At least 1.
								</p>
							) : (
								<p className="blok-error" id="total-error">
									{form.errors.total}
								</p>
							)}
						</div>

						<div className="blok-form__actions">
							<button type="submit" className="blok-btn blok-btn--primary" disabled={form.processing}>
								{form.processing ? <span className="blok-spinner" /> : null}
								{form.processing ? "Saving…" : "Save order"}
							</button>
							<Link href="/" className="blok-btn">
								Cancel
							</Link>
							<PrecognitionStatus validating={form.validating} valid={form.valid("sku") && form.valid("total")} />
						</div>
					</form>
				</div>
			</div>
		</>
	);
}

/** The live-validation indicator: the whole point of the Precognition round trip. */
function PrecognitionStatus({ validating, valid }: { validating: boolean; valid: boolean }) {
	if (validating) {
		return (
			<output className="blok-form__status">
				<span className="blok-spinner" /> Validating…
			</output>
		);
	}
	if (valid) {
		return <output className="blok-form__status blok-form__status--valid">✓ Looks good</output>;
	}
	return null;
}

Create.layout = appLayout;
