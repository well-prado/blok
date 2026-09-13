/**
 * Stand-in for the file the Blok type generator emits (#998), shared by all
 * four fixtures. It does the two augmentations a real project gets: Blok's
 * `Pages`/`Routes`, and Inertia's own `InertiaConfig` so the stock hooks
 * (`usePage`, `useForm`, …) are typed without any Blok-specific wrapper.
 */
import "@blokjs/inertia-client";
import "@inertiajs/core";

declare module "@blokjs/inertia-client" {
	interface Pages {
		"Orders/Index": { orders: { id: string; total: number }[] };
		"Orders/Show": { order: { id: string; total: number } };
	}

	interface Routes {
		"orders.index": { method: "get"; component: "Orders/Index" };
		"orders.show": { params: { id: string }; method: "get"; component: "Orders/Show" };
	}
}

declare module "@inertiajs/core" {
	interface InertiaConfig {
		sharedPageProps: { auth: { email: string } };
		flashDataType: { toast?: { type: "success" | "error"; message: string } };
		errorValueType: string;
	}
}
