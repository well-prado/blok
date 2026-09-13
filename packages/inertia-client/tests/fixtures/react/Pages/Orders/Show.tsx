import type { PagePropsOf } from "@blokjs/inertia-client";
import type ordersShow from "../../workflow.js";

export default function Show({ order, auth }: PagePropsOf<typeof ordersShow>) {
	return (
		<div>
			<span>{auth.email}</span>
			<span>{order.total}</span>
		</div>
	);
}
