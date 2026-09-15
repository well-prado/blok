/**
 * The fixture's workflow registry — the middleware chain, shared data, error
 * pages, and the workflows the TS file scanner cannot route by itself (it only
 * routes a file's DEFAULT export).
 *
 * `blokctl add spa` wrote the `inertia.shared` / `inertia.csrf` half of this
 * file; the conformance fixture adds `inertia.auth`, the error-page map, and
 * the shared `auth` key an instant visit carries to the next page.
 */

import type { WorkflowV2Builder } from "@blokjs/helper";
import {
	configureErrorPages,
	createAuthMiddleware,
	createCsrfMiddleware,
	createSharedMiddleware,
	share,
} from "@blokjs/inertia";
import { currentUser } from "#app/nodes/e2e/index";
import { errorWorkflow, externalWorkflow, fragmentWorkflow, pythonCallsWorkflow } from "#app/workflows/e2e-control";
import mcpPing from "#app/workflows/e2e-mcp";

/**
 * `auth` is a SHARED key as well as a page prop. Registering it is what puts it
 * in the page object's `sharedProps`, which is the list an instant visit
 * carries to the next page (scenario 36). A page that declares `auth` itself
 * owns the key completely — the resolver below never runs for those.
 */
share("auth", (req: unknown) => {
	const header = (req as { headers?: Record<string, unknown> } | undefined)?.headers?.cookie;
	const match = /(?:^|;\s*)e2e_session=([^;]*)/.exec(String(header ?? ""));
	const email = match ? decodeURIComponent(match[1] as string) : "";
	return email === "" ? { id: "", email: "" } : { id: `u-${email}`, email };
});

/** Production error pages as Inertia responses (scenario 34). */
configureErrorPages({
	pages: { 403: "Errors/Error", 404: "Errors/Error", 500: "Errors/Error", default: "Errors/Error" },
});

const workflows: Record<string, WorkflowV2Builder> = {
	"inertia.shared": await createSharedMiddleware({ currentUser }),
	// The `__e2e/*` control routes are the suite's own surface, not the app's:
	// exempting them is the same `except` a webhook endpoint uses, and it keeps
	// a version bump from depending on the browser's current token.
	"inertia.csrf": await createCsrfMiddleware({ except: ["__e2e/*"] }),
	"inertia.auth": await createAuthMiddleware({ redirectTo: "/login" }),
	// A non-HTTP trigger is not auto-routed: the TS scanner only routes HTTP
	// workflows, and the entrypoint's preCatchAllHook mounts MCP ones from here.
	"e2e-mcp-ping": await mcpPing,
	"e2e-python-calls": await pythonCallsWorkflow,
	"e2e-error": await errorWorkflow,
	"e2e-external": await externalWorkflow,
	"e2e-fragment": await fragmentWorkflow,
};

export default workflows;
