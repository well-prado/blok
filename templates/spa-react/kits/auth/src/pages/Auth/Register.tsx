import { Head, Link, useForm } from "@inertiajs/react";
import { guestLayout } from "../../components/GuestLayout.js";

/**
 * `Auth/Register` — create an account (#1018).
 *
 * The field names are the kit's `RegisterSchema` (`@blokjs/auth`): rename one
 * here and the server's error keys stop matching. Success starts a session and
 * lands on `/dashboard`; a duplicate address comes back as `errors.email`.
 */
export default function Register() {
	const form = useForm("post", "/register", {
		name: "",
		email: "",
		password: "",
		passwordConfirmation: "",
	});

	return (
		<>
			<Head title="Create an account" />

			<h1>Create an account</h1>
			<p className="blok-lede">Takes a moment. No email confirmation in the scaffold.</p>

			<form
				className="blok-form"
				onSubmit={(event) => {
					event.preventDefault();
					form.post("/register", { onFinish: () => form.reset("password", "passwordConfirmation") });
				}}
			>
				<div className="blok-field">
					<label className="blok-label" htmlFor="name">
						Name
					</label>
					<input
						id="name"
						name="name"
						autoComplete="name"
						className="blok-input"
						value={form.data.name}
						onChange={(event) => form.setData("name", event.target.value)}
						aria-invalid={form.errors.name === undefined ? undefined : true}
						aria-describedby={form.errors.name === undefined ? undefined : "name-error"}
					/>
					{form.errors.name === undefined ? null : (
						<p className="blok-error" id="name-error">
							{form.errors.name}
						</p>
					)}
				</div>

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

				<div className="blok-field">
					<label className="blok-label" htmlFor="password">
						Password
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
						Confirm password
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
						{form.processing ? "Creating…" : "Create account"}
					</button>
					<Link href="/login" className="blok-btn">
						I already have one
					</Link>
				</div>
			</form>
		</>
	);
}

Register.layout = guestLayout;
