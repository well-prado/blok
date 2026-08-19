/**
 * The typed-handle DSL from `@blokjs/core` — Blok's canonical TypeScript
 * authoring surface. This example imports a node's VALUE (`apiCall`,
 * `RespondNode`) and passes it to `step()`; the sibling `countries-helper` /
 * `countries-cats-helper` use the name-only `node("@blokjs/api-call")` form.
 *
 * `step(id, node, inputs)` runs the node and returns a TYPED handle. Pass that
 * handle straight into a later step — no `$`, no `js/`, no raw `ctx` strings;
 * the runner resolves it. Object-style `workflow({ steps: [...] })` from
 * `@blokjs/helper` and JSON remain supported (same engine, same IR).
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
