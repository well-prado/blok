// @blokjs/helper — the workflow & node authoring surface.
//
// This entry is intentionally small: the symbols a workflow/node AUTHOR needs.
// Validation schemas, step-shape type-guards, trigger-config schemas, the
// `$`-proxy internals, and the runtime step/workflow types live behind
// `@blokjs/helper/internal` — tooling occasionally needs them, authors don't.

import { type BranchOpts, branch } from "./components/branch";
import { eq, gt, gte, lt, lte, ne, not } from "./components/eq";
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
import { $ } from "./proxy/$";
import type { V2StepUi } from "./types/StepOpts";
import type {
	CronTriggerOpts,
	HttpMethod,
	HttpTriggerOpts,
	McpTransport,
	McpTriggerOpts,
	PubSubProvider,
	PubSubTriggerOpts,
	QueueProvider,
	QueueTriggerOpts,
	SSETriggerOpts,
	TriggerOpts,
	WebSocketTriggerOpts,
	WebhookTriggerOpts,
	WorkerProvider,
	WorkerTriggerOpts,
} from "./types/TriggerOpts";
import { WORKFLOW_IR_VERSION, type WorkflowIR, WorkflowIRSchema } from "./types/WorkflowOpts";
import { parseDuration, tryParseDuration } from "./utils/parseDuration";
import { type WorkflowValidationError, type WorkflowValidationResult, validateWorkflow } from "./validateWorkflow";

export {
	// v2 DSL primitives — the canonical authoring surface
	workflow,
	branch,
	// First-class condition comparators (emit raw ctx — avoid the `when` footgun)
	eq,
	ne,
	gt,
	gte,
	lt,
	lte,
	not,
	// control-flow primitives
	forEach,
	loop,
	switchOn,
	tryCatch,
	// typed runtime-context proxy
	$,
	// v2 DSL option types
	type BranchOpts,
	type ForEachOpts,
	type LoopOpts,
	type SwitchOpts,
	type SwitchCase,
	type TryCatchOpts,
	type WorkflowV2Opts,
	type WorkflowV2Builder,
	// typed-client surface (phantom types for @blokjs/client)
	type TypedWorkflow,
	type EventMap,
	type EventUnion,
	type EmptyEventMap,
	type InferOr,
	type V2StepUi,
	// v2 IR schema contract
	WorkflowIRSchema,
	WORKFLOW_IR_VERSION,
	type WorkflowIR,
	// advisory shared validator (CLI / registry / Studio / AI authoring checks)
	validateWorkflow,
	type WorkflowValidationResult,
	type WorkflowValidationError,
	// per-trigger config TYPES (each trigger package re-exports its own)
	type HttpTriggerOpts,
	type TriggerOpts,
	type HttpMethod,
	type CronTriggerOpts,
	type QueueTriggerOpts,
	type QueueProvider,
	type PubSubTriggerOpts,
	type PubSubProvider,
	type WorkerTriggerOpts,
	type WorkerProvider,
	type WebhookTriggerOpts,
	type WebSocketTriggerOpts,
	type SSETriggerOpts,
	type McpTriggerOpts,
	type McpTransport,
	// duration parser (runner + worker trigger consume these)
	parseDuration,
	tryParseDuration,
};
