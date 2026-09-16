import { Head, useForm } from "@inertiajs/react";

import { layout } from "../components/Layout.js";

export default function Login() {
	const form = useForm({ email: "", password: "", to: "/secret" });

	return (
		<>
			<Head title="Login" />
			<h1 data-testid="page-heading">Login</h1>
			<form
				data-testid="form-login"
				onSubmit={(event) => {
					event.preventDefault();
					form.post("/login");
				}}
			>
				<label htmlFor="email">Email</label>
				<input
					id="email"
					data-testid="email"
					value={form.data.email}
					onChange={(event) => form.setData("email", event.target.value)}
				/>
				<label htmlFor="password">Password</label>
				<input
					id="password"
					type="password"
					data-testid="password"
					value={form.data.password}
					onChange={(event) => form.setData("password", event.target.value)}
				/>
				<button type="submit" data-testid="submit-login">
					Sign in
				</button>
			</form>
		</>
	);
}

Login.layout = layout;
