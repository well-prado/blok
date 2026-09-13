/**
 * A page component typed ONLY by the generated `blok-pages.d.ts`
 * (`../inertia-app/golden/`). It compiles iff the generator emitted a valid
 * augmentation of `Pages`, `Routes` and Inertia's `InertiaConfig` (#998 tests
 * 8, 10, 11, 12).
 */
import { type PageProps, route } from "@blokjs/inertia-client";
import type { ErrorValue, SharedPageProps } from "@inertiajs/core";

export default function OrdersIndex(props: PageProps<"Orders/Index">) {
	// Zod object → object type; nested array → array of objects.
	const total: number = props.orders.items[0]?.total ?? 0;
	// `z.union([...])` and `z.enum([...])` survive as unions.
	const status: "open" | "closed" | number = props.status.status;
	const source: "web" | "api" = props.status.source;
	// `optional()` / `defer()` props are optional keys (#998 test 10).
	const revenue: number | undefined = props.stats?.revenue;
	const open: boolean | undefined = props.filters?.open;
	// A `runtimeNode()` stub has no Zod schema: `unknown`, never `any`.
	const legacy: unknown = props.legacy;
	// `errorValueType: string` from the emitted InertiaConfig block.
	const title: ErrorValue | undefined = props.errors.title;
	// The empty `sharedPageProps` block still resolves as a type.
	const shared: SharedPageProps = {};

	// A route WITH params demands them; one without takes none (#998 test 2).
	const href: string = route("orders.show", { id: "o-1" }).url;
	const index = route("orders.index");

	return (
		<ul data-shared={JSON.stringify(shared)}>
			<li>{`${total} ${status} ${source} ${revenue} ${open} ${String(legacy)} ${title}`}</li>
			<li>{`${href} ${index.url} ${index.method} ${index.component ?? ""}`}</li>
		</ul>
	);
}
