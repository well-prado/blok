import { Head } from "@inertiajs/react";
import { layout } from "../../components/Layout.js";

interface Props {
	order: { id: string; sku: string; title: string; qty: number };
}

export default function Show({ order }: Props) {
	return (
		<>
			<Head title={`Order ${order.id}`} />
			<h1 data-testid="page-heading">Order {order.id}</h1>
			<p data-testid="order-sku">{order.sku}</p>
		</>
	);
}

Show.layout = layout;
