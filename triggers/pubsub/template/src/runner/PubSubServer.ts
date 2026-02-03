import { GCPPubSubAdapter, PubSubTrigger } from "@blokjs/trigger-pubsub";
import nodes from "../Nodes";
import workflows from "../Workflows";

/**
 * PubSubServer - Concrete Pub/Sub trigger implementation
 *
 * This server extends the abstract PubSubTrigger and provides:
 * - A specific adapter (GCP Pub/Sub by default, can be changed to AWS or Azure)
 * - Node and workflow registries
 *
 * To change the provider, replace:
 * - GCPPubSubAdapter with AWSSNSAdapter or AzureServiceBusAdapter
 * - Update the adapter configuration accordingly
 *
 * @example AWS SNS/SQS
 * ```typescript
 * import { AWSSNSAdapter } from "@blokjs/trigger-pubsub";
 * protected adapter = new AWSSNSAdapter({
 *   region: process.env.AWS_REGION || "us-east-1",
 * });
 * ```
 *
 * @example Azure Service Bus
 * ```typescript
 * import { AzureServiceBusAdapter } from "@blokjs/trigger-pubsub";
 * protected adapter = new AzureServiceBusAdapter({
 *   connectionString: process.env.AZURE_SERVICE_BUS_CONNECTION_STRING || "",
 * });
 * ```
 */
export default class PubSubServer extends PubSubTrigger {
	protected adapter = new GCPPubSubAdapter({
		projectId: process.env.GCP_PROJECT_ID || "my-project",
	});

	protected nodes = nodes;
	protected workflows = workflows;
}
