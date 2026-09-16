import { Head, router } from "@inertiajs/react";
import { layout } from "../components/Layout.js";

interface Props {
	auth: { id: string; email: string };
}

export default function Secret({ auth }: Props) {
	return (
		<>
			<Head title="Secret" />
			<h1 data-testid="page-heading">Secret</h1>
			<p data-testid="secret-email">{auth.email}</p>
			<button type="button" data-testid="logout" onClick={() => router.post("/logout")}>
				Logout
			</button>
		</>
	);
}

Secret.layout = layout;
