import AddElse from "./components/AddElse";
import AddIf, { ConditionOpts } from "./components/AddIf";
import HelperResponse from "./components/HelperResponse";
import Step from "./components/StepNode";
import Trigger from "./components/Trigger";
import Workflow from "./components/Workflow";
import { type BranchOpts, branch } from "./components/branch";
import { type WorkflowV2Builder, type WorkflowOpts as WorkflowV2Opts, workflow } from "./components/workflowV2";
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
	V2RegularStep,
	V2RegularStepSchema,
	V2Step,
	V2StepSchema,
	V2SubworkflowStep,
	V2SubworkflowStepSchema,
	V2WaitStep,
	V2WaitStepSchema,
	isBranchStep,
	isSubworkflowStep,
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
	WorkerTriggerOpts,
	WorkerTriggerOptsSchema,
	concurrencyRefinement,
	makeSchedulingRefinement,
	validateTriggerConfig,
} from "./types/TriggerOpts";
import { WorkflowV2, WorkflowV2Schema } from "./types/WorkflowOpts";
import { parseDuration, tryParseDuration } from "./utils/parseDuration";

export {
	AddElse,
	AddIf,
	ConditionOpts,
	HelperResponse,
	NodeType,
	NodeTypeSchema,
	RuntimeKind,
	RuntimeKindSchema,
	Step,
	StepInputs,
	StepOpts,
	Trigger,
	Workflow,
	// v2 DSL primitives — the canonical authoring surface
	workflow,
	branch,
	$,
	unwrapProxies,
	// v2 DSL types
	type BranchOpts,
	type WorkflowV2Opts,
	type WorkflowV2Builder,
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
