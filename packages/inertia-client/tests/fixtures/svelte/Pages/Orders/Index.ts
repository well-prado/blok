/**
 * The `<script lang="ts">` body of a Svelte page, as a plain `.ts` module so
 * it can be checked by `tsc` rather than `svelte-check` — the Blok types it
 * exercises are the same either way. `$$props` is a Svelte compiler binding,
 * declared here because this fixture is compiled as a bare module.
 */
import { type PageProps, route } from "@blokjs/inertia-client";
import { usePage } from "@inertiajs/svelte";

declare const $$props: PageProps<"Orders/Index">;

const props: PageProps<"Orders/Index"> = $$props;

// Test 11: the generated InertiaConfig augmentation types the stock hook.
export const email: string = usePage().props.auth.email;
export const firstError: string | undefined = props.errors.title;
export const total: number = props.orders[0].total;
export const href = route("orders.show", { id: props.orders[0].id });
