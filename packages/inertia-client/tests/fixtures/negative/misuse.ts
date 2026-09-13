/**
 * Every way the typed surface is supposed to reject a mistake. `tsc --noEmit`
 * over this fixture passes only if EVERY `@ts-expect-error` below is a real
 * error — an accidentally permissive type turns the unused suppression into a
 * compile failure of its own.
 */
import { type PageProps, type PagePropsOf, route } from "@blokjs/inertia-client";

// @ts-expect-error — "Nope/Missing" is not a known page.
export type Missing = PageProps<"Nope/Missing">;

const props = {} as PageProps<"Orders/Index">;

// @ts-expect-error — typo: the prop is `orders`.
export const typo = props.ordrs;

// @ts-expect-error — `orders` is an array of objects, not of strings.
export const wrongType: string[] = props.orders;

// @ts-expect-error — "nope" is not a registered route.
export const unknownRoute = route("nope");

// @ts-expect-error — "orders.show" requires an `id` param.
export const missingParams = route("orders.show");

// @ts-expect-error — the param is `id`, not `orderId`.
export const wrongParam = route("orders.show", { orderId: "1" });

// @ts-expect-error — "orders.index" takes no params.
export const unexpectedParams = route("orders.index", { id: "1" });

declare const notAPage: { props: { order: string } };
// @ts-expect-error — a value without a `__props` field is not a page module.
export type NotAPage = PagePropsOf<typeof notAPage>;

// The positive controls, so the fixture fails loudly if the module stops
// resolving altogether and every line above "errors" for the wrong reason.
export const fine: number = props.orders[0].total;
export const url: string = route("orders.show", { id: "1" }).url;
export const shared: string = props.auth.email;
