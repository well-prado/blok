import { http, node, step, workflow } from "@blokjs/core";

/**
 * Example Pub/Sub PRODUCER — an HTTP endpoint that publishes to the broker.
 *
 * `curl -X POST localhost:4000/orders -d '{"id":"o1"}'` publishes the body to
 * the `orders.placed` topic; the paired `on-pubsub-message` consumer (a
 * `trigger: { pubsub }` workflow on the same topic) then fires and logs it —
 * so the full produce → broker → consume loop is verifiable from the scaffold.
 *
 * `@blokjs/pubsub-publish` is a HELPER_NODE (always registered) that resolves
 * the adapter from `provider` (here "nats") → BLOK_PUBSUB_ADAPTER → nats. Only
 * registered when the project also has an HTTP trigger (this workflow has an
 * http trigger; a pubsub-only project can't serve the endpoint).
 */
export default workflow("Publish Order", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
	step("publish", node("@blokjs/pubsub-publish"), {
		provider: "nats",
		topic: "orders.placed",
		payload: req.body,
	});
});
