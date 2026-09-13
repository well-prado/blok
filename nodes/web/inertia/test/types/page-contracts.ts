/**
 * Type fixtures for `definePage()` (#995 tests 1–7 and 14–16, #1008 test 13).
 *
 * Compiled by `tsc --noEmit -p tsconfig.typetest.json`, never executed. Every
 * `@ts-expect-error` is an assertion: the line below it MUST fail to compile, so
 * a regression that loosens the contract turns the directive into an "unused
 * @ts-expect-error" error and fails the build.
 */

import { http, type Handle, defineNode, runtimeNode, workflow } from "@blokjs/core";
import { z } from "zod";
import {
	type PageProps,
	always,
	defer,
	definePage,
	merge,
	once,
	optional,
	scroll,
	shared,
} from "../../src/define-page.js";

// =============================================================================
// Nodes
// =============================================================================

const currentUser = defineNode({
	name: "ty-current-user",
	description: "auth",
	input: z.object({}),
	output: z.object({ id: z.string(), email: z.string() }),
	async execute() {
		return { id: "u", email: "e" };
	},
});

const listOrders = defineNode({
	name: "ty-list-orders",
	description: "orders",
	input: z.object({ userId: z.string() }),
	output: z.object({ items: z.array(z.object({ id: z.string() })) }),
	async execute() {
		return { items: [] };
	},
});

const loadFilters = defineNode({
	name: "ty-load-filters",
	description: "filters",
	input: z.object({}),
	output: z.object({ open: z.boolean() }),
	async execute() {
		return { open: true };
	},
});

const loadPlans = defineNode({
	name: "ty-load-plans",
	description: "plans",
	input: z.object({}),
	output: z.object({ tiers: z.array(z.string()) }),
	async execute() {
		return { tiers: [] };
	},
});

const paginatePosts = defineNode({
	name: "ty-paginate-posts",
	description: "posts",
	input: z.object({}),
	output: z.object({ data: z.array(z.string()), page: z.number() }),
	async execute() {
		return { data: [], page: 1 };
	},
});

/** 7 — a cross-runtime stub is a first-class prop node. */
const pyStats = runtimeNode<{ userId: string }, { total: number }>("py.stats", "runtime.python3");

const OrdersIndex = definePage("Ty/Orders", {
	auth: always(currentUser),
	orders: listOrders,
	filters: optional(loadFilters),
	stats: defer(pyStats, { group: "dashboard", rescue: true }),
	feed: merge(listOrders, { append: "items", matchOn: "id" }),
	plans: once(loadPlans, { until: "1h" }),
	posts: scroll(paginatePosts, { wrapper: "data" }),
});

// =============================================================================
// 1 / 14 — correct inputs compile; wrong ones do not
// =============================================================================

export async function correct() {
	return workflow("ty-ok", { version: "1.0.0", trigger: http.get("/ty") }, (req) => {
		OrdersIndex.render(req, "page", "/ty", {
			orders: { userId: shared(currentUser, "auth").id },
			stats: { userId: "u-1" },
			feed: { userId: "u-1" },
		});
	});
}

export async function wrongInputType() {
	return workflow("ty-wrong-type", { version: "1.0.0", trigger: http.get("/ty2") }, (req) => {
		OrdersIndex.render(req, "page", "/ty2", {
			// @ts-expect-error 14 — `userId` is a string, not a number.
			orders: { userId: 123 },
			stats: { userId: "u-1" },
			feed: { userId: "u-1" },
		});
	});
}

export async function wrongHandleShape() {
	return workflow("ty-wrong-handle", { version: "1.0.0", trigger: http.get("/ty3") }, (req) => {
		OrdersIndex.render(req, "page", "/ty3", {
			// @ts-expect-error 2 — an orders-shaped handle is not `listOrders`'s input.
			orders: shared(listOrders, "somewhere"),
			stats: { userId: "u-1" },
			feed: { userId: "u-1" },
		});
	});
}

export async function missingRequiredPropInputs() {
	return workflow("ty-missing", { version: "1.0.0", trigger: http.get("/ty4") }, (req) => {
		// @ts-expect-error 3 — `orders`/`stats`/`feed` all take a required input.
		OrdersIndex.render(req, "page", "/ty4", {});
	});
}

/** 4 — a prop whose node takes NO required input may be omitted. */
export async function omittingInputlessProps() {
	return workflow("ty-omit", { version: "1.0.0", trigger: http.get("/ty5") }, (req) => {
		OrdersIndex.render(req, "page", "/ty5", {
			orders: { userId: "u-1" },
			stats: { userId: "u-1" },
			feed: { userId: "u-1" },
			// `auth`, `filters`, `plans`, `posts` all take `{}` — omitted on purpose.
		});
	});
}

// =============================================================================
// 5 / 15 / 16 — PageProps optionality per mode
// =============================================================================

type Props = PageProps<typeof OrdersIndex>;

/** Assert `Actual` and `Expected` are the same type, both ways. */
type Exact<Actual, Expected> = [Actual] extends [Expected] ? ([Expected] extends [Actual] ? true : false) : false;
function assertExact<T extends true>(_ok: T): void {}

// 5 — `auth` is required and fully typed.
assertExact<Exact<Props["auth"], { id: string; email: string }>>(true);
assertExact<Exact<Props["auth"]["email"], string>>(true);
// 15 — `optional` and `defer` keys are `T | undefined`.
assertExact<Exact<Props["filters"], { open: boolean } | undefined>>(true);
assertExact<Exact<Props["stats"], { total: number } | undefined>>(true);
// 16 — a `once` prop is REQUIRED: the client rehydrates it from its own cache.
assertExact<Exact<Props["plans"], { tiers: string[] }>>(true);
// merge / scroll props are ordinary required props carrying their own shape.
assertExact<Exact<Props["feed"], { items: { id: string }[] }>>(true);
assertExact<Exact<Props["posts"], { data: string[]; page: number }>>(true);
// 5 — `errors` is always present, and `withAllErrors` may make a field an array.
assertExact<Exact<Props["errors"], Record<string, string | string[]>>>(true);

export function readsProps(props: Props): string {
	const email: string = props.auth.email;
	// @ts-expect-error 15 — `stats` may be absent; it needs a guard first.
	const total: number = props.stats.total;
	void total;
	return email;
}

// =============================================================================
// 6 — shared() is a typed handle over the node's OUTPUT
// =============================================================================

const auth = shared(currentUser, "auth");
const authId: Handle<string> = auth.id;
void authId;

// @ts-expect-error 6 — `nope` is not a field of `currentUser`'s output.
const nope = auth.nope;
void nope;

// =============================================================================
// 13 (#1008) — a `PageDef` carries its prop type for the frontend
// =============================================================================

/** Mirrors `@blokjs/inertia-client`'s `PagePropsOf<T extends { __props: unknown }>`. */
type PagePropsOf<T extends { __props: unknown }> = T["__props"] & { errors: Record<string, string | string[]> };
assertExact<Exact<PagePropsOf<typeof OrdersIndex>["auth"], { id: string; email: string }>>(true);
