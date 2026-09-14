import { type PageProps, route } from "@blokjs/inertia-client";
import { Head, Link } from "@inertiajs/react";
import { appLayout } from "../../components/AppLayout.js";

/**
 * The second named route. Without this component the `route("orders.show")`
 * link on the index page resolves to a page the bundle does not contain, and
 * the client throws instead of navigating.
 */
export default function Show({ order }: PageProps<"Orders/Show">) {
	return (
		<>
			<Head title={order.sku} />

			<div className="blok-page-header">
				<div>
					<p className="blok-eyebrow">Order</p>
					<h1>{order.sku}</h1>
				</div>
				<div className="blok-page-header__end">
					<Link href={route("orders.index")} className="blok-btn">
						Back to orders
					</Link>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-table-wrap">
					<table className="blok-table">
						<tbody>
							<tr>
								<td className="blok-muted">Id</td>
								<td>
									<code>{order.id}</code>
								</td>
							</tr>
							<tr>
								<td className="blok-muted">SKU</td>
								<td>{order.sku}</td>
							</tr>
							<tr>
								<td className="blok-muted">Total</td>
								<td>${order.total}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</>
	);
}

Show.layout = appLayout;
