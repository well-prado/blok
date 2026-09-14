import { type PageProps, route } from "@blokjs/inertia-client";
import { Head, Link } from "@inertiajs/react";
import { appLayout } from "../../components/AppLayout.js";

/**
 * Standalone mode types the client from the GENERATED `blok-pages.d.ts` —
 * `PageProps<"Orders/Index">`, not an import from the server. The look is the
 * same `blok.css` the in-project examples use; only the wiring differs.
 */
export default function Index({ auth, orders }: PageProps<"Orders/Index">) {
	const total = orders.reduce((sum, order) => sum + order.total, 0);

	return (
		<>
			<Head title="Orders" />

			<div className="blok-page-header">
				<div>
					<p className="blok-eyebrow">Inertia · standalone mode</p>
					<h1>Orders</h1>
					<p className="blok-lede">
						This SPA is served by Vite on its own origin and talks to Blok cross-origin, with credentials on.
					</p>
				</div>
			</div>

			<div className="blok-stats">
				<div className="blok-stat">
					<p className="blok-stat__label">Orders</p>
					<p className="blok-stat__value">{orders.length}</p>
					<p className="blok-stat__delta">regular prop</p>
				</div>
				<div className="blok-stat">
					<p className="blok-stat__label">Order value</p>
					<p className="blok-stat__value">${total}</p>
					<p className="blok-stat__delta blok-stat__delta--up">derived on the client</p>
				</div>
				<div className="blok-stat">
					<p className="blok-stat__label">Signed in as</p>
					<p className="blok-stat__value" style={{ fontSize: "1rem" }}>
						{auth.email}
					</p>
					<p className="blok-stat__delta">always() shared prop</p>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>All orders</h2>
					<span className="blok-badge">regular</span>
				</div>
				<div className="blok-table-wrap">
					<table className="blok-table">
						<thead>
							<tr>
								<th scope="col">Order</th>
								<th scope="col">SKU</th>
								<th scope="col" className="blok-num">
									Total
								</th>
							</tr>
						</thead>
						<tbody>
							{orders.map((order) => (
								<tr key={order.id}>
									<td>
										<code>{order.id}</code>
									</td>
									<td>
										<Link href={route("orders.show", { id: order.id })}>{order.sku}</Link>
									</td>
									<td className="blok-num">${order.total}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</>
	);
}

Index.layout = appLayout;
