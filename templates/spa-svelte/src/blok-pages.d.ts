// Placeholder — `blokctl gen app-types --out src` overwrites this file with the
// real page/route types scanned from your Blok workflows (#998). Until then it
// declares the one page this scaffold ships, so `PageProps<"Home">` compiles.
import "@blokjs/inertia-client";
import "@inertiajs/core";

declare module "@blokjs/inertia-client" {
	interface Pages {
		Home: {
			home: {
				title: string;
				body: string;
			};
		};
	}
}

declare module "@inertiajs/core" {
	interface InertiaConfig {
		sharedPageProps: Record<never, never>;
		flashDataType: Record<string, unknown>;
		errorValueType: string;
	}
}
