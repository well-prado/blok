/**
 * Middleware chain and shared data. HTTP-triggered TS workflows under
 * `src/workflows/**` are auto-discovered, so the page is not listed here.
 */

import { createSharedMiddleware, share } from "@blokjs/inertia";
import { currentUser } from "./nodes.js";

share("appName", "Blok SPA example (Vue)");

export default {
	"inertia.shared": await createSharedMiddleware({ currentUser }),
};
