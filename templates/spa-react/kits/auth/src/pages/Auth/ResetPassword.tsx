import type { PageProps } from "@blokjs/inertia-client";
import { Head, Link, useForm } from "@inertiajs/react";
import { guestLayout } from "../../components/GuestLayout.js";

/**
 * `Auth/ResetPassword` — choose a new password (#1018).
 *
 * `reset` is a real page prop: the `:token` from the URL, echoed by the kit's
 * `resetToken` node so the form can post it back. The token is single-use and
 * expires; the server checks it when it is SPENT, never here.
 */
export default function ResetPassword({ reset }: PageProps<"Auth/ResetPassword">) {
	const form = useForm("post", `/reset-password/${reset.token}`, {
		token: reset.token,
		email: reset.email ?? "",
		password: "",
		passwordConfirmation: "",
	});

	return (
		<>
			<Head title="Choose a new password" />

			<h1>Choose a new password</h1>
			<p className="blok-lede">This link works once.</p>

			<form
				className="blok-form"
				onSubmit={(event) => {
					event.preventDefault();
					form.post(`/reset-password/${reset.token}`, {
						onFinish: () => form.reset("password", "passwordConfirmation"),
					});
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

				<div className="blok-field">
					<label className="blok-label" htmlFor="password">
						New password
					</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="new-password"
						className="blok-input"
						value={form.data.password}
						onChange={(event) => form.setData("password", event.target.value)}
						aria-invalid={form.errors.password === undefined ? undefined : true}
						aria-describedby={form.errors.password === undefined ? "password-hint" : "password-error"}
					/>
					{form.errors.password === undefined ? (
						<p className="blok-hint" id="password-hint">
							At least 8 characters.
						</p>
					) : (
						<p className="blok-error" id="password-error">
							{form.errors.password}
						</p>
					)}
				</div>

				<div className="blok-field">
					<label className="blok-label" htmlFor="passwordConfirmation">
						Confirm new password
					</label>
					<input
						id="passwordConfirmation"
						name="passwordConfirmation"
						type="password"
						autoComplete="new-password"
						className="blok-input"
						value={form.data.passwordConfirmation}
						onChange={(event) => form.setData("passwordConfirmation", event.target.value)}
						aria-invalid={form.errors.passwordConfirmation === undefined ? undefined : true}
						aria-describedby={form.errors.passwordConfirmation === undefined ? undefined : "confirm-error"}
					/>
					{form.errors.passwordConfirmation === undefined ? null : (
						<p className="blok-error" id="confirm-error">
							{form.errors.passwordConfirmation}
						</p>
					)}
				</div>

				<div className="blok-form__actions">
					<button type="submit" className="blok-btn blok-btn--primary" disabled={form.processing}>
						{form.processing ? <span className="blok-spinner" /> : null}
						{form.processing ? "Saving…" : "Reset password"}
					</button>
					<Link href="/login" className="blok-btn">
						Back to sign in
					</Link>
				</div>
			</form>
		</>
	);
}

ResetPassword.layout = guestLayout;
