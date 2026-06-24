import { WorkerTrigger } from "@blokjs/trigger-worker";
import nodes from "../Nodes";
import workflows from "../Workflows";

/**
 * WorkerServer - Concrete Worker trigger implementation
 *
 * The adapter is resolved per-workflow via `trigger.worker.provider`, falling
 * back to the `BLOK_WORKER_ADAPTER` env var, then the zero-infra `in-memory`
 * adapter. That means a fresh project boots with no broker running.
 *
 * To force ONE adapter for EVERY workflow in this process, uncomment one of the
 * examples below. Note: a hardcoded `this.adapter` OVERRIDES the per-workflow
 * `provider` / `BLOK_WORKER_ADAPTER` resolution, so prefer leaving it commented
 * unless you really want a single broker for the whole process.
 *
 *   import { NATSWorkerAdapter } from "@blokjs/trigger-worker";
 *   protected adapter = new NATSWorkerAdapter({
 *     servers: (process.env.NATS_SERVERS || "localhost:4222").split(","),
 *   });
 *
 *   // Requires `npm install bullmq` (peer dependency).
 *   import { BullMQAdapter } from "@blokjs/trigger-worker";
 *   protected adapter = new BullMQAdapter({
 *     connection: {
 *       host: process.env.REDIS_HOST || "localhost",
 *       port: Number(process.env.REDIS_PORT) || 6379,
 *     },
 *   });
 */
export default class WorkerServer extends WorkerTrigger {
	protected nodes: Record<string, import("@blokjs/runner").BlokService<unknown>> = nodes;
	protected workflows: Record<string, import("@blokjs/helper").WorkflowV2Builder> = workflows;
}
