import { Head } from "@inertiajs/react";
import { layout } from "../../components/Layout.js";

interface Props {
	status: number;
	message: string;
}

/** The production error page: a real Inertia response carrying a 4xx/5xx status. */
export default function ErrorPage({ status, message }: Props) {
	return (
		<>
			<Head title={`${status}`} />
			<h1 data-testid="page-heading">
				{status} — {message}
			</h1>
		</>
	);
}

ErrorPage.layout = layout;
