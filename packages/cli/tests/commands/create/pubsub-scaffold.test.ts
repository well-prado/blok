import { describe, expect, it } from "vitest";
import {
	generateSharedWorkflowsFile,
	getProviderDependencies,
	getProviderEnvVars,
} from "../../../src/commands/create/project.js";

/**
 * Regression (#645): the pubsub trigger had nothing verifiable to consume — the
 * shipped consumer was pointed at GCP + httpbin, NATS wasn't a selectable
 * provider, and no producer shipped. The scaffold now defaults to NATS (zero
 * cloud setup), registers a consumer + an HTTP producer, and wires the NATS
 * dep + env so `curl → broker → consumer logs` works out of the box.
 */
describe("pubsub scaffold — NATS verifiable consumer + producer (#645)", () => {
	it("wires the NATS pub/sub dependency + env when the provider is nats", () => {
		expect(getProviderDependencies(["pubsub"], "nats", "in-memory")).toHaveProperty("nats");

		const env = getProviderEnvVars(["pubsub"], "nats", "in-memory");
		expect(env).toContain("NATS_SERVERS=localhost:4222");
		expect(env).toContain("BLOK_PUBSUB_ADAPTER=nats");
	});

	// #733 — the HTTP producer (publish-order.ts) is http-triggered AND lives
	// under `src/workflows/`, the TS auto-routing scan root (#695): the HTTP
	// scan routes it with zero manual entries, same as the consumer would if it
	// carried an http trigger. A manual registration here used to be harmless
	// (dedup by object identity) but self-collided under a BUILT `npm run
	// start` run, where Workflows.ts imports the compiled module and the TS
	// scanner imports the source — two different module instances. Fixed at
	// the root: the producer is shipped to disk (still curl-able) but not
	// manually registered; the consumer (pubsub-triggered, not auto-routed by
	// the HTTP scan) still needs its manual entry so PubSubServer can find it.
	it("registers the consumer but leaves the HTTP producer for the TS scan to auto-route", () => {
		const out = generateSharedWorkflowsFile(["http", "pubsub"]);
		expect(out).toContain('import OnPubSubMessage from "./workflows/pubsub/messages/on-message.js";');
		// awaited — the callback-form workflow() is async; the unresolved Promise
		// would carry no readable trigger config and the consumer would be dropped.
		expect(out).toContain('"on-pubsub-message": await OnPubSubMessage');
		expect(out).not.toContain("PublishOrder");
		expect(out).not.toContain("publish-order");
	});

	it("registers the consumer for a pubsub-only project (no producer either way — no HTTP to serve it)", () => {
		const out = generateSharedWorkflowsFile(["pubsub"]);
		expect(out).toContain('"on-pubsub-message": await OnPubSubMessage');
		expect(out).not.toContain("publish-order");
	});
});
