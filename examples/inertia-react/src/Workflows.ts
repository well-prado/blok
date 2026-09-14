/**
 * The workflow registry: the middleware chain, shared data, and error pages.
 *
 * `inertia.shared` is an ORDINARY Blok middleware workflow — there is no
 * adapter-specific middleware system. It fills `ctx.state.auth` and reads the
 * signed flash cookie; the `page` control step folds the flash into the
 * response by itself.
 *
 * The page workflows themselves are NOT listed here: HTTP-triggered TS
 * workflows under `src/workflows/**` are auto-discovered, and registering one
 * twice is a route collision (#733).
 */

import {
	configureErrorPages,
	createAuthMiddleware,
	createCsrfMiddleware,
	createSharedMiddleware,
	share,
} from "@blokjs/inertia";
import { WorkflowRegistry } from "@blokjs/runner";
import { currentUser } from "./nodes.js";
import { page as ordersNewPage } from "./workflows/orders-create.js";

/** Shared data: every page gets it, and its key rides the page object. */
share("appName", "Blok SPA example");

/** Production error pages. In development the client's error modal is the point. */
configureErrorPages({
	pages: { 404: "Errors/Error", 500: "Errors/Error", default: "Errors/Error" },
});

export default {
	"inertia.shared": await createSharedMiddleware({ currentUser }),
	"inertia.auth": await createAuthMiddleware({ redirectTo: "/login" }),
	"inertia.csrf": await createCsrfMiddleware(),
	// `GET /orders/new` lives beside the submit in `orders-create.ts`, and the
	// file scanner only routes a file's DEFAULT export — so this second workflow
	// has to be registered by hand, or the "New order" link 404s. Not a
	// collision (#733): the scanner never saw it.
	"orders-create-page": ordersNewPage,
};

WorkflowRegistry.getInstance().setGlobalMiddleware(["inertia.csrf"]);
