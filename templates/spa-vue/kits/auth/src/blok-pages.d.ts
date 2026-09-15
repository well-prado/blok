// Placeholder — `blokctl gen app-types --out src` overwrites this file with the
// real page/route types scanned from your Blok workflows (#998). Until then it
// declares the pages this scaffold ships, so `PageProps<"Dashboard">` compiles.
//
// The auth pages come from the `--kit auth` routes in `src/workflows/auth/`;
// their prop types are the Zod output schemas of `@blokjs/auth`'s nodes.
import "@blokjs/inertia-client";
import "@inertiajs/core";

/** `@blokjs/auth`'s `currentUser` output — the `auth` prop every page carries. */
interface AuthProp {
	id?: string;
	user: {
		id: string;
		name: string;
		email: string;
	} | null;
}

declare module "@blokjs/inertia-client" {
	interface Pages {
		"Auth/ForgotPassword": {
			auth: AuthProp;
		};
		"Auth/Login": {
			auth: AuthProp;
		};
		"Auth/Register": {
			auth: AuthProp;
		};
		"Auth/ResetPassword": {
			auth: AuthProp;
			reset: {
				token: string;
				email?: string;
			};
		};
		Dashboard: {
			auth: AuthProp;
		};
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
