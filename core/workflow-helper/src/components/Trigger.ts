import {
	type CronTriggerOpts,
	type PubSubTriggerOpts,
	type QueueTriggerOpts,
	type SSETriggerOpts,
	type TriggerConfigMap,
	type TriggerOpts,
	TriggerOptsSchema,
	type TriggersEnum,
	TriggersSchema,
	type WebSocketTriggerOpts,
	type WebhookTriggerOpts,
	type WorkerTriggerOpts,
} from "../types/TriggerOpts";
import HelperResponse from "./HelperResponse";
import StepNode from "./StepNode";

export default class Trigger extends HelperResponse {
	// Overloads for type-safe trigger configuration
	addTrigger(name: "http", config: TriggerOpts): StepNode;
	addTrigger(name: "queue", config: QueueTriggerOpts): StepNode;
	addTrigger(name: "pubsub", config: PubSubTriggerOpts): StepNode;
	addTrigger(name: "cron", config: CronTriggerOpts): StepNode;
	addTrigger(name: "worker", config: WorkerTriggerOpts): StepNode;
	addTrigger(name: "webhook", config: WebhookTriggerOpts): StepNode;
	addTrigger(name: "sse", config: SSETriggerOpts): StepNode;
	addTrigger(name: "websocket", config: WebSocketTriggerOpts): StepNode;
	addTrigger(name: "grpc" | "manual", config?: Record<string, unknown>): StepNode;
	addTrigger<T extends TriggersEnum>(name: T, config?: TriggerConfigMap[T]): StepNode {
		TriggersSchema.parse(name);

		if (name === "http" && config) {
			TriggerOptsSchema.parse(config);
		}
		this._config.trigger = { [name]: config || {} };

		const helperResponse = new StepNode();
		helperResponse.setConfig(this._config);
		return helperResponse;
	}
}
