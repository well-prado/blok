import type { PageProps } from "@blokjs/inertia-client";
import { Head, Link } from "@inertiajs/react";

export default function Home({ home }: PageProps<"Home">) {
	return (
		<main
			style={{
				font: "400 1rem/1.6 system-ui, sans-serif",
				margin: "0 auto",
				maxWidth: "40rem",
				padding: "4rem 1.5rem",
			}}
		>
			<Head title="Home" />
			<h1 style={{ fontSize: "2rem", margin: "0 0 1rem" }}>{home.title}</h1>
			<p>{home.body}</p>
			<Link href="/">Visit this page again — without a full reload</Link>
		</main>
	);
}
