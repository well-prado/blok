import {
	type CronTriggerOpts,
	type HttpTriggerOpts,
	type PubSubTriggerOpts,
	type QueueTriggerOpts,
	type SSETriggerOpts,
	type TriggerConfigMap,
	type TriggersEnum,
	TriggersSchema,
	type WebSocketTriggerOpts,
	type WebhookTriggerOpts,
	type WorkerTriggerOpts,
	validateTriggerConfig,
} from "../types/TriggerOpts";
import HelperResponse from "./HelperResponse";
import StepNode from "./StepNode";

/**
 * Builder step that attaches a trigger to a workflow.
 *
 * Returned by {@link Workflow}; chains into {@link StepNode} via
 * {@link Trigger.addTrigger}. Type-safe overloads constrain the `config`
 * argument shape per trigger kind; {@link validateTriggerConfig} runs the
 * matching Zod schema at call time.
 */
export default class Trigger extends HelperResponse {
	addTrigger(name: "http", config: HttpTriggerOpts): StepNode;
	addTrigger(name: "queue", config: QueueTriggerOpts): StepNode;
	addTrigger(name: "pubsub", config: PubSubTriggerOpts): StepNode;
	addTrigger(name: "cron", config: CronTriggerOpts): StepNode;
	addTrigger(name: "worker", config: WorkerTriggerOpts): StepNode;
	addTrigger(name: "webhook", config: WebhookTriggerOpts): StepNode;
	addTrigger(name: "sse", config: SSETriggerOpts): StepNode;
	addTrigger(name: "websocket", config: WebSocketTriggerOpts): StepNode;
	addTrigger(name: "grpc" | "manual", config?: Record<string, unknown>): StepNode;
	addTrigger<T extends TriggersEnum>(name: T, config?: TriggerConfigMap[T]): StepNode {
		// Validate the trigger NAME first so callers get a clear error for typos
		// before we try to dispatch to a schema.
		TriggersSchema.parse(name);

		// Dispatch to the per-kind schema. Returns the parsed config (with
		// defaults applied) for typed triggers, or the input config for
		// grpc/manual which have no schema.
		const validated = validateTriggerConfig(name, config);
		this._config.trigger = { [name]: validated };

		const helperResponse = new StepNode();
		helperResponse.setConfig(this._config);
		return helperResponse;
	}
}
