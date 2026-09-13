/**
 * Every misuse here is marked `@ts-expect-error`, so this fixture compiles
 * CLEAN iff each one really is a type error. That is the negative half of
 * #998 test 8 (`props.nope`) plus the route and mode contracts.
 */
import type { PageProps } from "@blokjs/inertia-client";
import { route } from "@blokjs/inertia-client";
import type { ErrorValue } from "@inertiajs/core";

const props = {} as PageProps<"Orders/Index">;

// @ts-expect-error — a prop the page never declared.
props.nope;

// @ts-expect-error — `stats` is deferred, so it may be absent.
props.stats.revenue;

// @ts-expect-error — a page component that does not exist.
const missing = {} as PageProps<"Orders/Nope">;

// @ts-expect-error — an unregistered route name.
route("orders.nope");

// @ts-expect-error — `orders.show` requires its `:id` param.
route("orders.show");

// @ts-expect-error — `orders.index` takes no params.
route("orders.index", { id: "o-1" });

// @ts-expect-error — `errorValueType` is `string`, not `string[]`, without --with-all-errors.
const errors: ErrorValue = ["a"];

export type { missing, errors };
