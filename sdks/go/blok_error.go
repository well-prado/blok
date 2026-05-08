// Structured BlokError per master plan §17 — the canonical error contract
// every Blok node SDK populates the same way. Mirrors the TypeScript
// BlokError in core/shared/src/BlokError.ts and the Python BlokError in
// sdks/python3/blok/errors/blok_error.go so node authors writing in any
// language see the same field shape.
//
// Idiomatic usage (master plan §17.5 builder pattern):
//
//	return nil, blok.NewError(blok.CategoryDependency).
//	    Code("POSTGRES_CONNECT_TIMEOUT").
//	    Message("Could not connect to Postgres within 5s").
//	    Description(fmt.Sprintf("Tried host=%s port=%d; timeout=%s", host, port, dur)).
//	    Remediation("Check DATABASE_URL env var and network reachability").
//	    Cause(err).
//	    Retryable(true).
//	    RetryAfter(5 * time.Second).
//	    Details(map[string]any{"sql_state": "08001"}).
//	    Build()
//
// The legacy NodeError (5 categories) in errors.go stays available for
// back-compat. New code should prefer BlokError.

package blok

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"time"
)

// =============================================================================
// Categories — 12 values mirroring the proto blok.runtime.v1.ErrorCategory enum
// =============================================================================
//
// Reuses the existing ErrorCategory string type so legacy NodeError values
// (EXECUTION, NETWORK) stay valid. The proto serialization in grpc_server.go
// maps known→known and falls back to INTERNAL for legacy/unknown values.

const (
	// CategoryDependency: external dependency unreachable (DB, API, etc.). Retryable.
	CategoryDependency ErrorCategory = "DEPENDENCY"
	// CategoryTimeout: deadline exceeded (network, computation, lock). Retryable.
	CategoryTimeout ErrorCategory = "TIMEOUT"
	// CategoryPermission: caller lacks the right role/scope.
	CategoryPermission ErrorCategory = "PERMISSION"
	// CategoryRateLimit: caller exceeded a quota. Retryable with retry_after_ms.
	CategoryRateLimit ErrorCategory = "RATE_LIMIT"
	// CategoryConflict: idempotency violation, concurrent update.
	CategoryConflict ErrorCategory = "CONFLICT"
	// CategoryCancelled: caller cancelled before completion.
	CategoryCancelled ErrorCategory = "CANCELLED"
	// CategoryInternal: SDK threw without classification — default fallback.
	CategoryInternal ErrorCategory = "INTERNAL"
	// CategoryProtocol: wire-format / framing / serialization error.
	CategoryProtocol ErrorCategory = "PROTOCOL"
	// CategoryData: payload schema OK but values are unprocessable.
	CategoryData ErrorCategory = "DATA"
	// Aliases for the categories the legacy NodeError already declared:
	//   - CategoryValidation == ErrorCategoryValidation == "VALIDATION"
	//   - CategoryConfiguration == ErrorCategoryConfiguration == "CONFIGURATION"
	//   - CategoryNotFound == ErrorCategoryNotFound == "NOT_FOUND"
	CategoryValidation    = ErrorCategoryValidation
	CategoryConfiguration = ErrorCategoryConfiguration
	CategoryNotFound      = ErrorCategoryNotFound
)

// ErrorSeverity classifies how serious an error is.
type ErrorSeverity string

const (
	// SeverityInfo: informational, no action needed.
	SeverityInfo ErrorSeverity = "INFO"
	// SeverityWarn: recoverable, worth surfacing.
	SeverityWarn ErrorSeverity = "WARN"
	// SeverityError: standard error level (default for thrown errors).
	SeverityError ErrorSeverity = "ERROR"
	// SeverityFatal: process must terminate.
	SeverityFatal ErrorSeverity = "FATAL"
)

// DefaultHTTPStatus maps each category to its conventional HTTP status code.
// Authors override per-error via the .HTTPStatus(int) builder method.
var DefaultHTTPStatus = map[ErrorCategory]int{
	CategoryValidation:    400,
	CategoryConfiguration: 500,
	CategoryDependency:    502,
	CategoryTimeout:       504,
	CategoryPermission:    403,
	CategoryRateLimit:     429,
	CategoryNotFound:      404,
	CategoryConflict:      409,
	CategoryCancelled:     499,
	CategoryInternal:      500,
	CategoryProtocol:      502,
	CategoryData:          422,
}

// DefaultRetryable maps each category to a sensible retry hint default.
var DefaultRetryable = map[ErrorCategory]bool{
	CategoryValidation:    false,
	CategoryConfiguration: false,
	CategoryDependency:    true,
	CategoryTimeout:       true,
	CategoryPermission:    false,
	CategoryRateLimit:     true,
	CategoryNotFound:      false,
	CategoryConflict:      false,
	CategoryCancelled:     false,
	CategoryInternal:      false,
	CategoryProtocol:      false,
	CategoryData:          false,
}

// SDK-side identifiers for auto-enrichment when handlers don't set them.
const (
	DefaultSDKName     = "blok-go"
	DefaultRuntimeKind = "runtime.go"
)

// ContextSnapshotMaxBytes caps the JSON-serialized size of a context snapshot
// so trace + LLM payloads stay inspectable at a glance.
const ContextSnapshotMaxBytes = 4096

// =============================================================================
// BlokError — the structured error type
// =============================================================================

// BlokError is the canonical structured error per master plan §17. Returned
// from a NodeHandler.Execute to convey category-aware failure info that flows
// losslessly through the gRPC wire to the runner and into Studio traces.
//
// Use NewError(category) + builder methods to construct; direct struct
// literals work too if you prefer.
type BlokError struct {
	Category        ErrorCategory
	Severity        ErrorSeverity
	Code            string
	Message         string
	Description     string
	Remediation     string
	DocURL          string
	HTTPStatus      int
	Retryable       bool
	RetryAfterMs    int64
	Details         interface{}
	ContextSnapshot interface{}
	// Causes is a flat list of cause-chain payloads (outermost first). Already
	// flattened at construction time so cross-wire serialization doesn't
	// double-count nested chains.
	Causes []map[string]interface{}
	Stack  string
	At     time.Time

	// Origin — auto-enriched by the gRPC servicer when not set by the handler.
	Node        string
	SDK         string
	SDKVersion  string
	RuntimeKind string

	// underlyingCause keeps the original Go error for errors.Is / errors.Unwrap.
	underlyingCause error
}

// Error implements the error interface.
func (e *BlokError) Error() string {
	if e.underlyingCause != nil {
		return fmt.Sprintf("[%s] %s: %v", e.Category, e.Message, e.underlyingCause)
	}
	return fmt.Sprintf("[%s] %s", e.Category, e.Message)
}

// Unwrap returns the underlying Go error so errors.Is / errors.As traverse
// the cause chain naturally.
func (e *BlokError) Unwrap() error {
	return e.underlyingCause
}

// =============================================================================
// Builder — chained construction matching the master plan §17.5 example
// =============================================================================

// ErrorBuilder is the fluent constructor returned by NewError. Each chained
// method returns the same builder; Build() finalizes into a *BlokError with
// auto-fields populated (At, Stack, defaults).
type ErrorBuilder struct {
	err *BlokError
}

// NewError starts a new BlokError builder for the given category. Defaults
// (HTTPStatus, Retryable, Severity) come from the per-category tables and
// can be overridden via the matching builder methods.
func NewError(category ErrorCategory) *ErrorBuilder {
	httpStatus, ok := DefaultHTTPStatus[category]
	if !ok {
		httpStatus = 500
	}
	retryable := DefaultRetryable[category]
	return &ErrorBuilder{err: &BlokError{
		Category:   category,
		Severity:   SeverityError,
		HTTPStatus: httpStatus,
		Retryable:  retryable,
	}}
}

// Code sets the stable machine identifier for this error
// (e.g. "POSTGRES_CONNECT_TIMEOUT").
func (b *ErrorBuilder) Code(c string) *ErrorBuilder { b.err.Code = c; return b }

// Message sets the one-sentence human summary.
func (b *ErrorBuilder) Message(m string) *ErrorBuilder { b.err.Message = m; return b }

// Description sets the multi-paragraph context (what was tried, why it failed).
func (b *ErrorBuilder) Description(d string) *ErrorBuilder { b.err.Description = d; return b }

// Remediation sets the suggested next step for the developer.
func (b *ErrorBuilder) Remediation(r string) *ErrorBuilder { b.err.Remediation = r; return b }

// DocURL sets a link to documentation explaining this error code.
func (b *ErrorBuilder) DocURL(u string) *ErrorBuilder { b.err.DocURL = u; return b }

// HTTPStatus overrides the default HTTP status for this category.
func (b *ErrorBuilder) HTTPStatus(s int) *ErrorBuilder { b.err.HTTPStatus = s; return b }

// Severity overrides the default severity (ERROR).
func (b *ErrorBuilder) Severity(s ErrorSeverity) *ErrorBuilder { b.err.Severity = s; return b }

// Retryable overrides the default retryable hint.
func (b *ErrorBuilder) Retryable(r bool) *ErrorBuilder { b.err.Retryable = r; return b }

// RetryAfter sets the suggested retry-after duration. Stored as
// milliseconds in the proto wire format.
func (b *ErrorBuilder) RetryAfter(d time.Duration) *ErrorBuilder {
	b.err.RetryAfterMs = d.Milliseconds()
	return b
}

// RetryAfterMs sets the suggested retry-after directly in milliseconds.
func (b *ErrorBuilder) RetryAfterMs(ms int64) *ErrorBuilder { b.err.RetryAfterMs = ms; return b }

// Details attaches category-specific structured details
// (Zod issues, SQL state, etc.).
func (b *ErrorBuilder) Details(d interface{}) *ErrorBuilder { b.err.Details = d; return b }

// ContextSnapshot attaches a bounded slice of inputs/state at error time.
// Use BuildContextSnapshot to construct one within the size budget.
func (b *ErrorBuilder) ContextSnapshot(s interface{}) *ErrorBuilder {
	b.err.ContextSnapshot = s
	return b
}

// Cause attaches an underlying Go error. The cause chain is walked at
// Build time and flattened into the .Causes payload list.
func (b *ErrorBuilder) Cause(c error) *ErrorBuilder { b.err.underlyingCause = c; return b }

// Node overrides the auto-filled node name (handlers normally don't set this).
func (b *ErrorBuilder) Node(n string) *ErrorBuilder { b.err.Node = n; return b }

// SDK overrides the auto-filled SDK identifier ("blok-go").
func (b *ErrorBuilder) SDK(s string) *ErrorBuilder { b.err.SDK = s; return b }

// SDKVersion overrides the auto-filled SDK version.
func (b *ErrorBuilder) SDKVersion(v string) *ErrorBuilder { b.err.SDKVersion = v; return b }

// RuntimeKind overrides the auto-filled runtime kind ("runtime.go").
func (b *ErrorBuilder) RuntimeKind(k string) *ErrorBuilder { b.err.RuntimeKind = k; return b }

// Build finalizes the BlokError, capturing the current timestamp + stack and
// flattening the cause chain. Subsequent calls to other builder methods
// after Build() have no effect (the builder is intentionally one-shot).
func (b *ErrorBuilder) Build() *BlokError {
	b.err.At = time.Now().UTC()
	b.err.Stack = string(debug.Stack())
	if b.err.underlyingCause != nil {
		b.err.Causes = flattenCauses(b.err.underlyingCause)
	}
	return b.err
}

// =============================================================================
// Conversion — FromUnknown, ToMap, FromMap
// =============================================================================

// FromUnknown wraps any error/value as a BlokError. Used by the runner's
// auto-wrap layer so legacy `errors.New("oops")` still produces a structured
// error. Categorization heuristic:
//
//   - *BlokError: passthrough; missing origin fields filled in.
//   - *NodeError (legacy): preserves message/details/cause; category=INTERNAL.
//   - error: wraps as INTERNAL with code=UNCAUGHT_<TYPE> and the error
//     preserved in the cause chain.
//   - map[string]interface{} / map[string]string: extracts "message" key,
//     full payload preserved in Details.
//   - string: becomes the message.
//   - nil: placeholder "node error".
//   - everything else: stringified, payload preserved in Details.
func FromUnknown(v interface{}, ctx Origin) *BlokError {
	switch err := v.(type) {
	case nil:
		return NewError(CategoryInternal).
			Code("UNCAUGHT_ERROR").
			Message("node error").
			applyOrigin(ctx).
			Build()
	case *BlokError:
		err.applyOriginIfMissing(ctx)
		return err
	case *NodeError:
		details := err.ToMap()
		return NewError(CategoryInternal).
			Code("UNCAUGHT_NODEERROR").
			Message(err.Message).
			Details(details).
			Cause(err.Cause).
			applyOrigin(ctx).
			Build()
	case error:
		return NewError(CategoryInternal).
			Code(uncaughtCode(err)).
			Message(err.Error()).
			Cause(err).
			applyOrigin(ctx).
			Build()
	case string:
		return NewError(CategoryInternal).
			Code("UNCAUGHT_ERROR").
			Message(err).
			Details(map[string]interface{}{"message": err}).
			applyOrigin(ctx).
			Build()
	case map[string]interface{}:
		return wrapMap(err, ctx)
	case map[string]string:
		converted := make(map[string]interface{}, len(err))
		for k, v := range err {
			converted[k] = v
		}
		return wrapMap(converted, ctx)
	default:
		text, mErr := json.Marshal(err)
		if mErr != nil {
			text = []byte(fmt.Sprintf("%v", err))
		}
		message := string(text)
		return NewError(CategoryInternal).
			Code("UNCAUGHT_ERROR").
			Message(message).
			Details(map[string]interface{}{"message": message}).
			applyOrigin(ctx).
			Build()
	}
}

func wrapMap(m map[string]interface{}, ctx Origin) *BlokError {
	message, _ := m["message"].(string)
	if message == "" {
		message = "node error"
	}
	return NewError(CategoryInternal).
		Code("UNCAUGHT_ERROR").
		Message(message).
		Details(m).
		applyOrigin(ctx).
		Build()
}

// Origin carries the auto-enrichment fields the gRPC servicer fills in when
// a handler-thrown BlokError doesn't have them.
type Origin struct {
	Node        string
	SDK         string
	SDKVersion  string
	RuntimeKind string
}

// DefaultOrigin returns an Origin populated with the SDK constants
// (DefaultSDKName, DefaultRuntimeKind). The servicer fills Node + SDKVersion
// at call time.
func DefaultOrigin(node, sdkVersion string) Origin {
	return Origin{
		Node:        node,
		SDK:         DefaultSDKName,
		SDKVersion:  sdkVersion,
		RuntimeKind: DefaultRuntimeKind,
	}
}

func (b *ErrorBuilder) applyOrigin(o Origin) *ErrorBuilder {
	if b.err.Node == "" {
		b.err.Node = o.Node
	}
	if b.err.SDK == "" {
		b.err.SDK = o.SDK
	}
	if b.err.SDKVersion == "" {
		b.err.SDKVersion = o.SDKVersion
	}
	if b.err.RuntimeKind == "" {
		b.err.RuntimeKind = o.RuntimeKind
	}
	return b
}

// applyOriginIfMissing fills in *missing* origin fields on an
// already-constructed BlokError (e.g. handler-thrown). Won't overwrite
// fields the handler set explicitly.
func (e *BlokError) applyOriginIfMissing(o Origin) {
	if e.Node == "" {
		e.Node = o.Node
	}
	if e.SDK == "" {
		e.SDK = o.SDK
	}
	if e.SDKVersion == "" {
		e.SDKVersion = o.SDKVersion
	}
	if e.RuntimeKind == "" {
		e.RuntimeKind = o.RuntimeKind
	}
}

// EnrichOrigin is a public helper for the gRPC servicer to fill in missing
// origin fields on a handler-thrown BlokError before serializing.
func (e *BlokError) EnrichOrigin(o Origin) *BlokError {
	e.applyOriginIfMissing(o)
	return e
}

// ToMap serializes the BlokError to a JSON-friendly map matching the proto
// wire format. Inverse of FromMap.
func (e *BlokError) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"code":             e.Code,
		"category":         string(e.Category),
		"severity":         string(e.Severity),
		"node":             e.Node,
		"sdk":              e.SDK,
		"sdk_version":      e.SDKVersion,
		"runtime_kind":     e.RuntimeKind,
		"at":               e.At.Format(time.RFC3339Nano),
		"message":          e.Message,
		"description":      e.Description,
		"remediation":      e.Remediation,
		"doc_url":          e.DocURL,
		"causes":           causesAsAny(e.Causes),
		"stack":            e.Stack,
		"context_snapshot": e.ContextSnapshot,
		"http_status":      e.HTTPStatus,
		"retryable":        e.Retryable,
		"retry_after_ms":   e.RetryAfterMs,
		"details":          e.Details,
	}
}

// FromMap reconstructs a BlokError from a JSON-decoded map. Accepts both
// snake_case (Go convention) and camelCase (TS payload shape) keys for
// cross-language fixture compatibility.
func FromMap(m map[string]interface{}) *BlokError {
	b := NewError(parseCategory(getAny(m, "category")))
	if code, ok := getString(m, "code"); ok {
		b.Code(code)
	}
	if msg, ok := getString(m, "message"); ok {
		b.Message(msg)
	}
	if desc, ok := getString(m, "description"); ok {
		b.Description(desc)
	}
	if rem, ok := getString(m, "remediation"); ok {
		b.Remediation(rem)
	}
	if doc, ok := getString(m, "doc_url", "docUrl"); ok {
		b.DocURL(doc)
	}
	if status, ok := getInt(m, "http_status", "httpStatus"); ok {
		b.HTTPStatus(status)
	}
	if r, ok := getBool(m, "retryable"); ok {
		b.Retryable(r)
	}
	if ra, ok := getInt64(m, "retry_after_ms", "retryAfterMs"); ok {
		b.RetryAfterMs(ra)
	}
	if d, ok := m["details"]; ok {
		b.Details(d)
	}
	if cs, ok := m["context_snapshot"]; ok {
		b.ContextSnapshot(cs)
	} else if cs, ok := m["contextSnapshot"]; ok {
		b.ContextSnapshot(cs)
	}
	if sev, ok := getString(m, "severity"); ok {
		b.Severity(parseSeverity(sev))
	}
	if n, ok := getString(m, "node"); ok {
		b.Node(n)
	}
	if s, ok := getString(m, "sdk"); ok {
		b.SDK(s)
	}
	if sv, ok := getString(m, "sdk_version", "sdkVersion"); ok {
		b.SDKVersion(sv)
	}
	if rk, ok := getString(m, "runtime_kind", "runtimeKind"); ok {
		b.RuntimeKind(rk)
	}
	built := b.Build()
	if at, ok := getString(m, "at"); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, at); err == nil {
			built.At = parsed
		} else if parsed, err := time.Parse(time.RFC3339, at); err == nil {
			built.At = parsed
		}
	}
	if stack, ok := getString(m, "stack"); ok {
		built.Stack = stack
	}
	if causes, ok := m["causes"].([]interface{}); ok {
		built.Causes = make([]map[string]interface{}, 0, len(causes))
		for _, c := range causes {
			if cm, ok := c.(map[string]interface{}); ok {
				built.Causes = append(built.Causes, cm)
			}
		}
	}
	return built
}

// =============================================================================
// Cause chain
// =============================================================================

func flattenCauses(cause error) []map[string]interface{} {
	causes := make([]map[string]interface{}, 0, 4)
	visited := make(map[error]struct{})
	current := cause
	for current != nil {
		if _, seen := visited[current]; seen {
			break
		}
		visited[current] = struct{}{}
		switch typed := current.(type) {
		case *BlokError:
			payload := typed.ToMap()
			payload["causes"] = []interface{}{}
			causes = append(causes, payload)
			for _, c := range typed.Causes {
				causes = append(causes, c)
			}
			return causes
		default:
			causes = append(causes, errToPayload(current))
			current = errors.Unwrap(current)
		}
	}
	return causes
}

func errToPayload(err error) map[string]interface{} {
	return map[string]interface{}{
		"code":             uncaughtCode(err),
		"category":         string(CategoryInternal),
		"severity":         string(SeverityError),
		"node":             "",
		"sdk":              "",
		"sdk_version":      "",
		"runtime_kind":     "",
		"at":               time.Now().UTC().Format(time.RFC3339Nano),
		"message":          err.Error(),
		"description":      "",
		"remediation":      "",
		"doc_url":          "",
		"causes":           []interface{}{},
		"stack":            "",
		"context_snapshot": nil,
		"http_status":      500,
		"retryable":        false,
		"retry_after_ms":   int64(0),
		"details":          nil,
	}
}

func uncaughtCode(err error) string {
	// Go error types don't have a stable .Name like Python; use the
	// concrete type's name via fmt's %T verb, then upper-case + sanitize.
	typeName := fmt.Sprintf("%T", err)
	// Strip leading "*" and package prefix to match Python's
	// `UNCAUGHT_<TYPE>` convention shape.
	for i := len(typeName) - 1; i >= 0; i-- {
		if typeName[i] == '.' {
			typeName = typeName[i+1:]
			break
		}
	}
	if typeName == "" {
		typeName = "ERROR"
	}
	upper := make([]byte, 0, len(typeName))
	for i := 0; i < len(typeName); i++ {
		c := typeName[i]
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			upper = append(upper, c)
		}
	}
	if len(upper) == 0 {
		return "UNCAUGHT_ERROR"
	}
	return "UNCAUGHT_" + string(upper)
}

func causesAsAny(causes []map[string]interface{}) []interface{} {
	out := make([]interface{}, len(causes))
	for i, c := range causes {
		out[i] = c
	}
	return out
}

// =============================================================================
// Context snapshot helper
// =============================================================================

// BuildContextSnapshot creates a JSON-friendly bounded slice of inputs +
// recent vars suitable for the BlokError.ContextSnapshot field. Per master
// plan §17.6: 4KB cap by default + last-N (default 16) vars keys, with
// progressive trimming when oversize. `inputs` is preserved as-is — it's
// the most LLM-actionable context.
func BuildContextSnapshot(inputs map[string]interface{}, vars map[string]interface{}) map[string]interface{} {
	return BuildContextSnapshotWithOpts(inputs, vars, ContextSnapshotMaxBytes, 16)
}

// BuildContextSnapshotWithOpts is the customizable variant of
// BuildContextSnapshot. maxVarsKeys=0 drops vars entirely; maxBytes<=0
// disables byte-budget trimming.
func BuildContextSnapshotWithOpts(
	inputs map[string]interface{},
	vars map[string]interface{},
	maxBytes int,
	maxVarsKeys int,
) map[string]interface{} {
	safeInputs := jsonSafeMap(inputs)
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	// Keep insertion-ish order as best Go can; use last N as the recent slice.
	// Go's maps don't preserve order, but for a 4KB-budget snapshot the
	// downstream consumer (LLM/Studio) doesn't care about ordering — just
	// that the keys are there.
	if maxVarsKeys >= 0 && len(keys) > maxVarsKeys {
		keys = keys[len(keys)-maxVarsKeys:]
	}
	recent := make(map[string]interface{}, len(keys))
	for _, k := range keys {
		recent[k] = vars[k]
	}
	safeVars := jsonSafeMap(recent)

	snapshot := map[string]interface{}{"inputs": safeInputs, "vars": safeVars}
	if maxBytes <= 0 {
		return snapshot
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil || len(encoded) <= maxBytes {
		return snapshot
	}
	for len(keys) > 0 {
		keys = keys[1:]
		recent = make(map[string]interface{}, len(keys))
		for _, k := range keys {
			recent[k] = vars[k]
		}
		snapshot["vars"] = jsonSafeMap(recent)
		encoded, err = json.Marshal(snapshot)
		if err == nil && len(encoded) <= maxBytes {
			return snapshot
		}
	}
	return map[string]interface{}{"inputs": safeInputs, "vars": map[string]interface{}{}, "_truncated": true}
}

func jsonSafeMap(m map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = jsonSafe(v)
	}
	return out
}

func jsonSafe(v interface{}) interface{} {
	switch x := v.(type) {
	case nil, bool, string, int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64:
		return x
	case map[string]interface{}:
		return jsonSafeMap(x)
	case []interface{}:
		out := make([]interface{}, len(x))
		for i, e := range x {
			out[i] = jsonSafe(e)
		}
		return out
	default:
		if _, err := json.Marshal(x); err == nil {
			return x
		}
		return fmt.Sprintf("%+v", x)
	}
}

// =============================================================================
// Internal: small map/getter helpers (FromMap implementation)
// =============================================================================

func parseCategory(v interface{}) ErrorCategory {
	if c, ok := v.(string); ok {
		switch ErrorCategory(c) {
		case CategoryValidation, CategoryConfiguration, CategoryDependency,
			CategoryTimeout, CategoryPermission, CategoryRateLimit,
			CategoryNotFound, CategoryConflict, CategoryCancelled,
			CategoryInternal, CategoryProtocol, CategoryData:
			return ErrorCategory(c)
		}
	}
	return CategoryInternal
}

func parseSeverity(v string) ErrorSeverity {
	switch ErrorSeverity(v) {
	case SeverityInfo, SeverityWarn, SeverityError, SeverityFatal:
		return ErrorSeverity(v)
	}
	return SeverityError
}

func getAny(m map[string]interface{}, keys ...string) interface{} {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return nil
}

func getString(m map[string]interface{}, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok {
				return s, true
			}
		}
	}
	return "", false
}

func getBool(m map[string]interface{}, keys ...string) (bool, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if b, ok := v.(bool); ok {
				return b, true
			}
		}
	}
	return false, false
}

func getInt(m map[string]interface{}, keys ...string) (int, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch x := v.(type) {
			case int:
				return x, true
			case int64:
				return int(x), true
			case float64:
				return int(x), true
			}
		}
	}
	return 0, false
}

func getInt64(m map[string]interface{}, keys ...string) (int64, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch x := v.(type) {
			case int:
				return int64(x), true
			case int64:
				return x, true
			case float64:
				return int64(x), true
			}
		}
	}
	return 0, false
}
