import { type BranchOpts, branch } from "./components/branch";
import { eq } from "./components/eq";
import { type ForEachOpts, forEach } from "./components/forEach";
import { type LoopOpts, loop } from "./components/loop";
import { type SwitchCase, type SwitchOpts, switchOn } from "./components/switchOn";
import { type TryCatchOpts, tryCatch } from "./components/tryCatch";
import {
	type EmptyEventMap,
	type EventMap,
	type EventUnion,
	type InferOr,
	type TypedWorkflow,
	type WorkflowV2Builder,
	type WorkflowOpts as WorkflowV2Opts,
	workflow,
} from "./components/workflowV2";
import { $, type DollarProxy, type ExprPath, JS_EXPR_TAG, unwrapProxies } from "./proxy/$";
import {
	NodeType,
	NodeTypeSchema,
	RetryConfig,
	RetryConfigSchema,
	RuntimeKind,
	RuntimeKindSchema,
	StepInputs,
	StepOpts,
	V2BranchStep,
	V2BranchStepSchema,
	V2ForEachStep,
	V2ForEachStepSchema,
	V2LoopStep,
	V2LoopStepSchema,
	V2RegularStep,
	V2RegularStepSchema,
	V2Step,
	V2StepSchema,
	V2SubworkflowStep,
	V2SubworkflowStepSchema,
	V2SwitchStep,
	V2SwitchStepSchema,
	V2TryCatchStep,
	V2TryCatchStepSchema,
	V2WaitStep,
	V2WaitStepSchema,
	isBranchStep,
	isForEachStep,
	isLoopStep,
	isSubworkflowStep,
	isSwitchStep,
	isTryCatchStep,
	isWaitStep,
} from "./types/StepOpts";
import {
	AnyTriggerOpts,
	// Concurrency keys (Tier 2 #6)
	ConcurrencyOpts,
	ConcurrencyOptsFields,
	ConcurrencyOptsSchema,
	// Cron
	CronTriggerOpts,
	CronTriggerOptsSchema,
	// Scheduling: delay/ttl/debounce (Tier 2 #5 + #7)
	DebounceOpts,
	DebounceOptsSchema,
	// HTTP method enum (canonical names + legacy * preprocess)
	HTTP_METHODS,
	// HTTP (preferred name)
	HttpMethod,
	HttpMethodSchema,
	HttpTriggerOpts,
	HttpTriggerOptsSchema,
	McpResourceMetaSchema,
	McpToolMetaSchema,
	// MCP
	McpTransport,
	McpTransportSchema,
	McpTriggerOpts,
	McpTriggerOptsSchema,
	// Pub/Sub
	PubSubProvider,
	PubSubProviderSchema,
	PubSubTriggerOpts,
	PubSubTriggerOptsSchema,
	// Queue
	QueueProvider,
	QueueProviderSchema,
	QueueTriggerOpts,
	QueueTriggerOptsSchema,
	// SSE
	SSETriggerOpts,
	SSETriggerOptsSchema,
	SchedulingOpts,
	SchedulingOptsFields,
	SchedulingOptsSchema,
	// Trigger registry
	TRIGGER_SCHEMAS,
	TriggerConfigMap,
	// HTTP (legacy aliases — deprecated)
	TriggerOpts,
	TriggerOptsSchema,
	TriggersEnum,
	// Triggers enum
	TriggersSchema,
	// WebSocket
	WebSocketTriggerOpts,
	WebSocketTriggerOptsSchema,
	// Webhook
	WebhookTriggerOpts,
	WebhookTriggerOptsSchema,
	// Worker
	WorkerProvider,
	WorkerProviderSchema,
	WorkerTriggerOpts,
	WorkerTriggerOptsSchema,
	concurrencyRefinement,
	makeSchedulingRefinement,
	validateTriggerConfig,
} from "./types/TriggerOpts";
import { WorkflowV2, WorkflowV2Schema } from "./types/WorkflowOpts";
import { parseDuration, tryParseDuration } from "./utils/parseDuration";

export {
	NodeType,
	NodeTypeSchema,
	RuntimeKind,
	RuntimeKindSchema,
	StepInputs,
	StepOpts,
	// v2 DSL primitives — the canonical authoring surface
	workflow,
	branch,
	// First-class condition equality (emits raw ctx — avoids the when footgun)
	eq,
	// v0.5 control-flow primitives
	forEach,
	loop,
	switchOn,
	tryCatch,
	$,
	unwrapProxies,
	// v2 DSL types
	type BranchOpts,
	type ForEachOpts,
	type LoopOpts,
	type SwitchOpts,
	type SwitchCase,
	type TryCatchOpts,
	type WorkflowV2Opts,
	type WorkflowV2Builder,
	// v2 typed-client surface (phantom types for @blokjs/client)
	type TypedWorkflow,
	type EventMap,
	type EventUnion,
	type EmptyEventMap,
	type InferOr,
	type DollarProxy,
	type ExprPath,
	JS_EXPR_TAG,
	// v2 step shapes
	V2Step,
	V2StepSchema,
	V2RegularStep,
	V2RegularStepSchema,
	V2BranchStep,
	V2BranchStepSchema,
	isBranchStep,
	// v2 sub-workflow step
	V2SubworkflowStep,
	V2SubworkflowStepSchema,
	isSubworkflowStep,
	// v2 wait step (PR 4)
	V2WaitStep,
	V2WaitStepSchema,
	isWaitStep,
	// v0.5 forEach + loop step shapes
	V2ForEachStep,
	V2ForEachStepSchema,
	isForEachStep,
	V2LoopStep,
	V2LoopStepSchema,
	isLoopStep,
	V2SwitchStep,
	V2SwitchStepSchema,
	isSwitchStep,
	V2TryCatchStep,
	V2TryCatchStepSchema,
	isTryCatchStep,
	// retry configuration
	RetryConfig,
	RetryConfigSchema,
	// v2 workflow envelope
	WorkflowV2,
	WorkflowV2Schema,
	// HTTP method enum
	HTTP_METHODS,
	HttpMethod,
	HttpMethodSchema,
	// Concurrency keys (Tier 2 #6)
	ConcurrencyOpts,
	ConcurrencyOptsFields,
	ConcurrencyOptsSchema,
	concurrencyRefinement,
	// Scheduling: delay/ttl/debounce (Tier 2 #5 + #7)
	DebounceOpts,
	DebounceOptsSchema,
	makeSchedulingRefinement,
	SchedulingOpts,
	SchedulingOptsFields,
	SchedulingOptsSchema,
	// Trigger types — preferred names
	HttpTriggerOpts,
	HttpTriggerOptsSchema,
	// Trigger types — legacy aliases (deprecated)
	TriggerOpts,
	TriggerOptsSchema,
	QueueProvider,
	QueueProviderSchema,
	QueueTriggerOpts,
	QueueTriggerOptsSchema,
	PubSubProvider,
	PubSubProviderSchema,
	PubSubTriggerOpts,
	PubSubTriggerOptsSchema,
	WorkerProvider,
	WorkerProviderSchema,
	WorkerTriggerOpts,
	WorkerTriggerOptsSchema,
	CronTriggerOpts,
	CronTriggerOptsSchema,
	WebhookTriggerOpts,
	WebhookTriggerOptsSchema,
	WebSocketTriggerOpts,
	WebSocketTriggerOptsSchema,
	SSETriggerOpts,
	SSETriggerOptsSchema,
	McpTransport,
	McpTransportSchema,
	McpToolMetaSchema,
	McpResourceMetaSchema,
	McpTriggerOpts,
	McpTriggerOptsSchema,
	TriggersSchema,
	TriggersEnum,
	// Trigger registry — runtime dispatch
	TriggerConfigMap,
	TRIGGER_SCHEMAS,
	AnyTriggerOpts,
	validateTriggerConfig,
	// Duration parser (Tier 2 #5 + #7)
	parseDuration,
	tryParseDuration,
};
