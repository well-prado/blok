import { type PageProps, route } from "@blokjs/inertia-client";
import { Link, usePage } from "@inertiajs/react";

export default function Index({ orders, errors }: PageProps<"Orders/Index">) {
	// Test 11: the generated InertiaConfig augmentation types the stock hook.
	const email: string = usePage().props.auth.email;
	const title: string | undefined = errors.title;

	return (
		<div>
			<span>{email}</span>
			<span>{title}</span>
			{orders.map((order) => (
				// Test 10: a Wayfinder-shaped route object used straight as `href`.
				<Link key={order.id} href={route("orders.show", { id: order.id })}>
					{order.total}
				</Link>
			))}
			<Link href={route("orders.index").withComponent("Orders/Index")}>All orders</Link>
		</div>
	);
}
