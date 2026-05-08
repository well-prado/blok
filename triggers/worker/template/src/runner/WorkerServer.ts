import { NATSWorkerAdapter, WorkerTrigger } from "@blokjs/trigger-worker";
import nodes from "../Nodes";
import workflows from "../Workflows";

/**
 * WorkerServer - Concrete Worker trigger implementation using NATS JetStream
 *
 * This server extends the abstract WorkerTrigger and provides:
 * - NATS JetStream adapter for persistent job queues
 * - Node and workflow registries
 * - Configurable concurrency, retries, and timeouts
 *
 * Environment variables:
 * - NATS_SERVERS: Comma-separated NATS server URLs (default: localhost:4222)
 * - NATS_STREAM_NAME: JetStream stream name (default: blok-worker)
 * - NATS_TOKEN: Authentication token (optional)
 *
 * @example BullMQ (Redis) alternative
 * ```typescript
 * import { BullMQAdapter } from "@blokjs/trigger-worker";
 * protected adapter = new BullMQAdapter({
 *   host: process.env.REDIS_HOST || "localhost",
 *   port: Number(process.env.REDIS_PORT) || 6379,
 * });
 * ```
 */
export default class WorkerServer extends WorkerTrigger {
	protected adapter = new NATSWorkerAdapter({
		servers: (process.env.NATS_SERVERS || "localhost:4222").split(","),
	});

	protected nodes: Record<string, import("@blokjs/runner").BlokService<unknown>> = nodes;
	protected workflows: Record<string, import("@blokjs/helper").HelperResponse> = workflows;
}
