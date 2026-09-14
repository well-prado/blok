/**
 * Standalone mode: the SPA is served from its own origin, so this process only
 * answers the protocol. CORS comes from `BLOK_CORS_ORIGIN` on the HTTP trigger
 * — see the README.
 */

import { createSharedMiddleware, resolveUrlUsing, share } from "@blokjs/inertia";
import { currentUser } from "./nodes.js";

share("appName", "Blok SPA example (standalone)");

// The page object's `url` must be the path the SPA's own origin shows, not this
// server's — the resolver is adapter-wide and wins over a page's own `url`.
resolveUrlUsing((req: unknown) => {
	const raw = (req as { url?: string }).url ?? "/";
	return new URL(raw, "http://backend.local").pathname;
});

export default {
	"inertia.shared": await createSharedMiddleware({ currentUser }),
};
