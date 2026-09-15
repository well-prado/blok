import { Head, Link, useForm } from "@inertiajs/react";
import { guestLayout } from "../../components/GuestLayout.js";

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
export default function ForgotPassword() {
	const form = useForm("post", "/forgot-password", { email: "" });

	return (
		<>
			<Head title="Forgot your password?" />

			<h1>Forgot your password?</h1>
			<p className="blok-lede">We will email you a link to choose a new one.</p>

			<form
				className="blok-form"
				onSubmit={(event) => {
					event.preventDefault();
					form.post("/forgot-password");
				}}
			>
				<div className="blok-field">
					<label className="blok-label" htmlFor="email">
						Email
					</label>
					<input
						id="email"
						name="email"
						type="email"
						autoComplete="username"
						className="blok-input"
						placeholder="you@example.com"
						value={form.data.email}
						onChange={(event) => form.setData("email", event.target.value)}
						aria-invalid={form.errors.email === undefined ? undefined : true}
						aria-describedby={form.errors.email === undefined ? undefined : "email-error"}
					/>
					{form.errors.email === undefined ? null : (
						<p className="blok-error" id="email-error">
							{form.errors.email}
						</p>
					)}
				</div>

				<div className="blok-form__actions">
					<button type="submit" className="blok-btn blok-btn--primary" disabled={form.processing}>
						{form.processing ? <span className="blok-spinner" /> : null}
						{form.processing ? "Sending…" : "Email the link"}
					</button>
					<Link href="/login" className="blok-btn">
						Back to sign in
					</Link>
				</div>
			</form>
		</>
	);
}

ForgotPassword.layout = guestLayout;
