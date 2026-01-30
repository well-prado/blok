/**
 * @blok/trigger-pubsub
 *
 * Pub/Sub-based trigger for Blok workflows.
 * Supports multiple pub/sub providers:
 * - Google Cloud Pub/Sub
 * - AWS SNS/SQS
 * - Azure Service Bus
 *
 * @example GCP Pub/Sub
 * ```typescript
 * import { PubSubTrigger, GCPPubSubAdapter } from "@blok/trigger-pubsub";
 *
 * class MyPubSubTrigger extends PubSubTrigger {
 *   protected adapter = new GCPPubSubAdapter({
 *     projectId: "my-project",
 *   });
 *
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MyPubSubTrigger();
 * await trigger.listen();
 * ```
 *
 * @example AWS SNS/SQS
 * ```typescript
 * import { PubSubTrigger, AWSSNSAdapter } from "@blok/trigger-pubsub";
 *
 * class MyPubSubTrigger extends PubSubTrigger {
 *   protected adapter = new AWSSNSAdapter({
 *     region: "us-east-1",
 *   });
 *   // ...
 * }
 * ```
 *
 * @example Azure Service Bus
 * ```typescript
 * import { PubSubTrigger, AzureServiceBusAdapter } from "@blok/trigger-pubsub";
 *
 * class MyPubSubTrigger extends PubSubTrigger {
 *   protected adapter = new AzureServiceBusAdapter({
 *     connectionString: process.env.AZURE_SERVICE_BUS_CONNECTION_STRING,
 *   });
 *   // ...
 * }
 * ```
 */

// Core exports
export {
	PubSubTrigger,
	type PubSubAdapter,
	type PubSubMessage,
} from "./PubSubTrigger";

// Adapters
export { GCPPubSubAdapter, type GCPPubSubConfig } from "./adapters/GCPPubSubAdapter";
export { AWSSNSAdapter, type AWSSNSConfig } from "./adapters/AWSSNSAdapter";
export { AzureServiceBusAdapter, type AzureServiceBusConfig } from "./adapters/AzureServiceBusAdapter";

// Re-export types from helper for convenience
export type {
	PubSubProvider,
	PubSubTriggerOpts,
} from "@blok/helper";
