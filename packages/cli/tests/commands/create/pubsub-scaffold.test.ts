import { describe, expect, it } from "vitest";
import {
	generateSharedWorkflowsFile,
	getProviderDependencies,
	getProviderEnvVars,
} from "../../../src/commands/create/project";

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

	it("registers the consumer AND the HTTP producer when http + pubsub are selected", () => {
		const out = generateSharedWorkflowsFile(["http", "pubsub"]);
		expect(out).toContain('import OnPubSubMessage from "./workflows/pubsub/messages/on-message";');
		// awaited — the callback-form workflow() is async; the unresolved Promise
		// would carry no readable trigger config and the consumer would be dropped.
		expect(out).toContain('"on-pubsub-message": await OnPubSubMessage');
		expect(out).toContain('import PublishOrder from "./workflows/pubsub/publish-order";');
		expect(out).toContain('"publish-order": await PublishOrder');
	});

	it("registers the consumer but NOT the producer for a pubsub-only project (no HTTP to serve it)", () => {
		const out = generateSharedWorkflowsFile(["pubsub"]);
		expect(out).toContain('"on-pubsub-message": await OnPubSubMessage');
		expect(out).not.toContain("publish-order");
	});
});
