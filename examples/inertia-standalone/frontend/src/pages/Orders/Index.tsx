import { type PageProps, route } from "@blokjs/inertia-client";
import { Link } from "@inertiajs/react";

/**
 * Standalone mode types the client from the GENERATED `blok-pages.d.ts` —
 * `PageProps<"Orders/Index">`, not an import from the server.
 */
export default function Index({ auth, orders }: PageProps<"Orders/Index">) {
	return (
		<main>
			<h1>{auth.email}</h1>
			<ul>
				{orders.map((order) => (
					<li key={order.id}>
						<Link href={route("orders.show", { id: order.id })}>{order.sku}</Link>
					</li>
				))}
			</ul>
		</main>
	);
}
