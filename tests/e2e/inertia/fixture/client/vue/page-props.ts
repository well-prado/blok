import type { PageProps } from "@blokjs/inertia-client";

/** Home's props, as `blokctl gen app-types` declares them. */
export type HomeProps = PageProps<"Home">;

/**
 * Scenario 19's typing gate, for the Vue cell.
 *
 * `tsc --noEmit` — what the scenario runs in `client/` — never parses `.vue`,
 * so a page component cannot be the gate `Home.tsx` is for React. This plain
 * module is, and `Home.vue` renders exactly what it returns: renaming `home:`
 * in `src/workflows/home.ts` drops the key from the generated contract, the
 * reads below fall through to Inertia's `[key: string]: unknown` shared-prop
 * index signature, and `unknown` stops compiling.
 */
export function homeCopy(props: HomeProps): { body: string; payload: string } {
	return { body: props.home.body, payload: props.home.payload };
}
