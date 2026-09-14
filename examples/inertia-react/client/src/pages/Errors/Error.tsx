interface Props {
	status: number;
	message: string;
}

/**
 * The production error page. Props are `{ status, message }`, where `message`
 * is the status's standard reason phrase — never the thrown error's message.
 */
export default function ErrorPage({ status, message }: Props) {
	return (
		<main>
			<h1>{status}</h1>
			<p>{message}</p>
		</main>
	);
}
