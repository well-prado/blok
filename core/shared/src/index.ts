/**
 * @packageDocumentation
 * @deprecated Prefer `@blokjs/core`. These primitives (Context, mapper,
 * NodeBase, error envelopes, …) are re-exported from `@blokjs/core/runtime`, so
 * a project only needs the one package (#374/#378). `@blokjs/shared` stays
 * published as a back-compat alias — existing imports keep working unchanged —
 * but new code should import from `@blokjs/core`.
 */
import BlokError, {
	type BlokErrorOpts,
	DEFAULT_HTTP_STATUS,
	DEFAULT_RETRYABLE,
	ErrorCategory,
	ErrorSeverity,
	isNonRetryableValidationError,
	type NodeErrorPayload,
	WORKFLOW_INPUT_VALIDATION,
} from "./BlokError";
import GlobalError from "./GlobalError";
import GlobalLogger from "./GlobalLogger";
import { Metrics, type MetricsType } from "./Metrics";
import NodeBase from "./NodeBase";
import Trigger from "./Trigger";
// These `types/*` modules are `type X = {...}; export default X;` — a type
// alias, not a runtime value (unlike `Trigger` above, a real class). Bun's
// per-file source loader (`bun -e import(...)`, in-monorepo scripts,
// bundler source-aliasing) can't see into the target file to know that; a
// plain value `import`/`export` of these names round-trips through a
// synthesized re-export that Bun rejects with "export default cannot be
// used with export *". `import type` here (and `type` on the corresponding
// `export { }` entries below) makes the type-only-ness explicit so no
// runtime binding is ever synthesized. See #702.
import type ConfigContext from "./types/ConfigContext";
import type ConnectionContext from "./types/ConnectionContext";
import type Context from "./types/Context";
import type EnvContext from "./types/EnvContext";
import type ErrorContext from "./types/ErrorContext";
import type FunctionContext from "./types/FunctionContext";
import type LoggerContext from "./types/LoggerContext";
import type NodeConfigContext from "./types/NodeConfigContext";
import type RequestContext from "./types/RequestContext";
import { RESPOND_BRAND, type RespondEnvelope, isRespondEnvelope } from "./types/RespondEnvelope";
import type ResponseContext from "./types/ResponseContext";
import type StateContext from "./types/StateContext";
import type Step from "./types/Step";
import type StreamContext from "./types/StreamContext";
import type VarsContext from "./types/VarsContext";
import mapper from "./utils/Mapper";
import { MapperResolutionError } from "./utils/MapperResolutionError";
import MemoryUsage from "./utils/MemoryUsage";
import { NamedMissingStateError } from "./utils/NamedMissingStateError";
import { type StructuralRef, type StructuralTpl, isStructuralRef, isStructuralTpl, lowerRefs } from "./utils/lowerRefs";

export {
	NodeBase,
	type Context,
	type RequestContext,
	type ResponseContext,
	RESPOND_BRAND,
	type RespondEnvelope,
	isRespondEnvelope,
	type EnvContext,
	type ErrorContext,
	type LoggerContext,
	type ConfigContext,
	type ConnectionContext,
	type StreamContext,
	Trigger,
	type NodeConfigContext,
	type FunctionContext,
	type StateContext,
	type VarsContext,
	type Step,
	GlobalLogger,
	GlobalError,
	BlokError,
	type BlokErrorOpts,
	type NodeErrorPayload,
	ErrorCategory,
	ErrorSeverity,
	DEFAULT_HTTP_STATUS,
	DEFAULT_RETRYABLE,
	isNonRetryableValidationError,
	WORKFLOW_INPUT_VALIDATION,
	Metrics,
	MemoryUsage,
	type MetricsType,
	mapper,
	MapperResolutionError,
	NamedMissingStateError,
	lowerRefs,
	// The lowering pass's OWN predicates — exported so the normalizer's
	// post-lowering total invariant (#707) tests the identical rule instead of
	// a second hand-written copy that could drift from what `lowerRefs` lowers.
	isStructuralRef,
	isStructuralTpl,
	type StructuralRef,
	type StructuralTpl,
};
