/**
 * The typed-handle DSL from `@blokjs/core` — Blok's lead TypeScript authoring
 * surface. Every other workflow this scaffold ships uses the object form
 * (`workflow({ steps: [...] })` from `@blokjs/helper`); this one showcases the
 * handle DSL so a fresh project has a runnable example to copy from.
 *
 * `step(id, node, inputs)` runs the node and returns a TYPED handle. Pass that
 * handle straight into a later step — no `$`, no `js/`, no raw `ctx` strings;
 * the runner resolves it. Same engine, same IR as the object/JSON forms.
 */
import apiCall from "@blokjs/api-call";
import { http, step, workflow } from "@blokjs/core";
import { RespondNode } from "@blokjs/helpers";

export default workflow("countries.dsl", { version: "1.0.0", trigger: http.get("/countries-dsl") }, () => {
	const countries = step("fetch", apiCall, {
		url: "https://countriesnow.space/api/v0.1/countries/capital",
		method: "GET",
		headers: { "Content-Type": "application/json" },
		responseType: "application/json",
	});

	step("respond", RespondNode, { body: countries }, { ephemeral: true });
});
