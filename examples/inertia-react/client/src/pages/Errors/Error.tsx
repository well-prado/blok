import { Head, Link } from "@inertiajs/react";
import { appLayout } from "../../components/AppLayout.js";

interface Props {
	status: number;
	message: string;
}

/**
 * The production error page. Props are `{ status, message }`, where `message`
 * is the status's standard reason phrase — never the thrown error's message.
 * The one-line help below is chosen from the status, so a 404 and a 500 do not
 * read as the same event to the person looking at them.
 */
const HELP: Record<number, string> = {
	403: "You are signed in, but this page is not yours to open.",
	404: "The link may be out of date, or that route does not exist yet.",
	500: "Something broke on the server. The failure was logged — try again in a moment.",
	503: "Blok is restarting or under maintenance. This usually clears in a few seconds.",
};

export default function ErrorPage({ status, message }: Props) {
	return (
		<>
			<Head title={`${status} ${message}`} />
			<div className="blok-error-page">
				<div>
					<p className="blok-error-page__status">{status}</p>
					<h1>{message}</h1>
					<p>{HELP[status] ?? "That request could not be completed."}</p>
					<Link href="/" className="blok-btn blok-btn--primary">
						Back to dashboard
					</Link>
				</div>
			</div>
		</>
	);
}

ErrorPage.layout = appLayout;
