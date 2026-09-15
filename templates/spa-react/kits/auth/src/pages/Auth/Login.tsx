import { Head, Link, useForm } from "@inertiajs/react";
import { guestLayout } from "../../components/GuestLayout.js";

/**
 * `Auth/Login` — the sign-in form (#1018).
 *
 * An ordinary Inertia form posting to the kit's `POST /login` workflow.
 * Everything Blok-specific is on the server: `@blokjs/validate` checks the
 * body, `@blokjs/auth`'s `login` node verifies the password (throttled per
 * IP + email), starts a fresh session and answers 303. A failure redirects
 * back with `props.errors.email` — which is what `form.errors.email` reads.
 */
export default function Login() {
	const form = useForm("post", "/login", { email: "", password: "", remember: false });

	return (
		<>
			<Head title="Sign in" />

			<h1>Sign in</h1>
			<p className="blok-lede">Welcome back.</p>

			<form
				className="blok-form"
				onSubmit={(event) => {
					event.preventDefault();
					form.post("/login", { onFinish: () => form.reset("password") });
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

				<div className="blok-field">
					<label className="blok-label" htmlFor="password">
						Password
					</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						className="blok-input"
						value={form.data.password}
						onChange={(event) => form.setData("password", event.target.value)}
						aria-invalid={form.errors.password === undefined ? undefined : true}
						aria-describedby={form.errors.password === undefined ? undefined : "password-error"}
					/>
					{form.errors.password === undefined ? null : (
						<p className="blok-error" id="password-error">
							{form.errors.password}
						</p>
					)}
				</div>

				<div className="blok-guest__row">
					<label className="blok-check" htmlFor="remember">
						<input
							id="remember"
							name="remember"
							type="checkbox"
							checked={form.data.remember}
							onChange={(event) => form.setData("remember", event.target.checked)}
						/>
						Remember me
					</label>
					<Link href="/forgot-password">Forgot your password?</Link>
				</div>

				<div className="blok-form__actions">
					<button type="submit" className="blok-btn blok-btn--primary" disabled={form.processing}>
						{form.processing ? <span className="blok-spinner" /> : null}
						{form.processing ? "Signing in…" : "Sign in"}
					</button>
					<Link href="/register" className="blok-btn">
						Create an account
					</Link>
				</div>
			</form>
		</>
	);
}

Login.layout = guestLayout;
