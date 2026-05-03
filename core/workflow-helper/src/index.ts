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
	isBranchStep,
} from "./types/StepOpts";
import {
	AnyTriggerOpts,
	// Cron
	CronTriggerOpts,
	CronTriggerOptsSchema,
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
	validateTriggerConfig,
} from "./types/TriggerOpts";
import { WorkflowV2, WorkflowV2Schema } from "./types/WorkflowOpts";

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
};
