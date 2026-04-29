// Unit tests for the structured BlokError per master plan §17.
//
// Mirrors the Python suite in sdks/python3/tests/test_blok_error.py.
// Covers all 12 category factories, builder option overrides, FromUnknown
// heuristics, ToMap/FromMap round-trip, cause chain flattening (cycle-safe),
// and BuildContextSnapshot byte-budget trimming.

package blok

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// =============================================================================
// Factories
// =============================================================================

func TestFactory_AllCategoriesSetCorrectDefaults(t *testing.T) {
	cases := []struct {
		category   ErrorCategory
		httpStatus int
		retryable  bool
	}{
		{CategoryValidation, 400, false},
		{CategoryConfiguration, 500, false},
		{CategoryDependency, 502, true},
		{CategoryTimeout, 504, true},
		{CategoryPermission, 403, false},
		{CategoryRateLimit, 429, true},
		{CategoryNotFound, 404, false},
		{CategoryConflict, 409, false},
		{CategoryCancelled, 499, false},
		{CategoryInternal, 500, false},
		{CategoryProtocol, 502, false},
		{CategoryData, 422, false},
	}
	for _, c := range cases {
		t.Run(string(c.category), func(t *testing.T) {
			err := NewError(c.category).Code("TEST").Message("m").Build()
			if err.Category != c.category {
				t.Errorf("category mismatch: got %s want %s", err.Category, c.category)
			}
			if err.HTTPStatus != c.httpStatus {
				t.Errorf("http_status: got %d want %d", err.HTTPStatus, c.httpStatus)
			}
			if err.Retryable != c.retryable {
				t.Errorf("retryable: got %v want %v", err.Retryable, c.retryable)
			}
			if err.Severity != SeverityError {
				t.Errorf("severity: got %s want ERROR", err.Severity)
			}
		})
	}
}

func TestBuilder_OptionsOverrideDefaults(t *testing.T) {
	cause := errors.New("underlying")
	err := NewError(CategoryDependency).
		Code("POSTGRES_DOWN").
		Message("db down").
		Description("long story").
		Remediation("restart it").
		DocURL("https://example.com/x").
		Retryable(false).
		RetryAfter(10 * time.Second).
		Details(map[string]interface{}{"sql_state": "08001"}).
		HTTPStatus(503).
		Severity(SeverityFatal).
		Cause(cause).
		Build()

	if err.Retryable {
		t.Error("Retryable should override default true")
	}
	if err.HTTPStatus != 503 {
		t.Errorf("HTTPStatus: got %d want 503", err.HTTPStatus)
	}
	if err.Severity != SeverityFatal {
		t.Errorf("Severity: got %s want FATAL", err.Severity)
	}
	if err.Description != "long story" || err.Remediation != "restart it" || err.DocURL != "https://example.com/x" {
		t.Error("description/remediation/docurl not set")
	}
	if err.RetryAfterMs != 10_000 {
		t.Errorf("RetryAfterMs: got %d want 10000", err.RetryAfterMs)
	}
	if d, ok := err.Details.(map[string]interface{}); !ok || d["sql_state"] != "08001" {
		t.Errorf("Details mismatch: %#v", err.Details)
	}
	if !errors.Is(err, cause) {
		t.Error("errors.Is should traverse to underlying cause")
	}
}

func TestBuilder_AtIsUTC(t *testing.T) {
	err := NewError(CategoryInternal).Code("X").Message("m").Build()
	if err.At.Location() != time.UTC {
		t.Errorf("expected UTC time, got %s", err.At.Location())
	}
	if time.Since(err.At) > 5*time.Second {
		t.Errorf("At too old: %s", err.At)
	}
}

func TestBuilder_StackIsCaptured(t *testing.T) {
	err := NewError(CategoryInternal).Code("X").Message("m").Build()
	if err.Stack == "" {
		t.Error("expected non-empty Stack")
	}
}

// =============================================================================
// FromUnknown heuristics
// =============================================================================

func TestFromUnknown_PassesThroughBlokError(t *testing.T) {
	original := NewError(CategoryDependency).Code("X").Message("m").Build()
	wrapped := FromUnknown(original, Origin{})
	if wrapped != original {
		t.Errorf("expected passthrough, got new instance")
	}
}

func TestFromUnknown_EnrichesMissingOriginFields(t *testing.T) {
	original := NewError(CategoryDependency).Code("X").Message("m").Build()
	wrapped := FromUnknown(original, Origin{Node: "step-x", SDK: "blok-go", SDKVersion: "1.0.0", RuntimeKind: "runtime.go"})
	if wrapped.Node != "step-x" || wrapped.SDK != "blok-go" || wrapped.SDKVersion != "1.0.0" || wrapped.RuntimeKind != "runtime.go" {
		t.Errorf("origin not enriched: %#v", wrapped)
	}
}

func TestFromUnknown_DoesNotOverwriteExplicitOriginFields(t *testing.T) {
	original := NewError(CategoryDependency).Code("X").Message("m").Node("explicit").Build()
	wrapped := FromUnknown(original, Origin{Node: "from-ctx"})
	if wrapped.Node != "explicit" {
		t.Errorf("Node was overwritten: got %q", wrapped.Node)
	}
}

func TestFromUnknown_WrapsGoErrorWithUncaughtTypeName(t *testing.T) {
	wrapped := FromUnknown(errors.New("bad number"), Origin{})
	if wrapped.Category != CategoryInternal {
		t.Errorf("expected INTERNAL, got %s", wrapped.Category)
	}
	if !strings.HasPrefix(wrapped.Code, "UNCAUGHT_") {
		t.Errorf("expected UNCAUGHT_* code, got %s", wrapped.Code)
	}
	if wrapped.Message != "bad number" {
		t.Errorf("message: got %q", wrapped.Message)
	}
	if len(wrapped.Causes) == 0 {
		t.Error("cause chain should have at least one entry")
	}
}

func TestFromUnknown_WrapsLegacyNodeError(t *testing.T) {
	legacy := NewExecutionError("legacy boom", errors.New("inner"))
	wrapped := FromUnknown(legacy, Origin{})
	if wrapped.Category != CategoryInternal {
		t.Errorf("expected INTERNAL, got %s", wrapped.Category)
	}
	if wrapped.Message != "legacy boom" {
		t.Errorf("message: got %q", wrapped.Message)
	}
	d, ok := wrapped.Details.(map[string]interface{})
	if !ok {
		t.Fatalf("Details should be a map: %#v", wrapped.Details)
	}
	if d["category"] != "EXECUTION" {
		t.Errorf("legacy category not preserved: %#v", d)
	}
}

func TestFromUnknown_WrapsMapExtractingMessage(t *testing.T) {
	wrapped := FromUnknown(map[string]interface{}{"message": "boom", "extra": 42}, Origin{})
	if wrapped.Code != "UNCAUGHT_ERROR" {
		t.Errorf("expected UNCAUGHT_ERROR, got %s", wrapped.Code)
	}
	if wrapped.Message != "boom" {
		t.Errorf("message: got %q", wrapped.Message)
	}
}

func TestFromUnknown_WrapsMapWithoutMessageUsesPlaceholder(t *testing.T) {
	wrapped := FromUnknown(map[string]interface{}{"only": "fields"}, Origin{})
	if wrapped.Message != "node error" {
		t.Errorf("expected placeholder, got %q", wrapped.Message)
	}
}

func TestFromUnknown_WrapsMapStringString(t *testing.T) {
	wrapped := FromUnknown(map[string]string{"message": "boom"}, Origin{})
	if wrapped.Message != "boom" {
		t.Errorf("got %q", wrapped.Message)
	}
}

func TestFromUnknown_WrapsString(t *testing.T) {
	wrapped := FromUnknown("plain", Origin{})
	if wrapped.Message != "plain" {
		t.Errorf("got %q", wrapped.Message)
	}
	d, ok := wrapped.Details.(map[string]interface{})
	if !ok || d["message"] != "plain" {
		t.Errorf("Details: %#v", wrapped.Details)
	}
}

func TestFromUnknown_WrapsNil(t *testing.T) {
	wrapped := FromUnknown(nil, Origin{})
	if wrapped.Code != "UNCAUGHT_ERROR" || wrapped.Message != "node error" {
		t.Errorf("unexpected wrap: %#v", wrapped)
	}
}

// =============================================================================
// ToMap / FromMap round-trip
// =============================================================================

func TestToMap_EmitsProtoWireShape(t *testing.T) {
	err := NewError(CategoryDependency).
		Code("POSTGRES_DOWN").
		Message("db down").
		Description("long story").
		Remediation("restart it").
		Retryable(true).
		RetryAfterMs(5_000).
		Details(map[string]interface{}{"sql_state": "08001"}).
		Node("step-1").
		SDK("blok-go").
		SDKVersion("1.0.0").
		RuntimeKind("runtime.go").
		Build()

	m := err.ToMap()
	if m["code"] != "POSTGRES_DOWN" {
		t.Errorf("code: %v", m["code"])
	}
	if m["category"] != "DEPENDENCY" {
		t.Errorf("category: %v", m["category"])
	}
	if m["http_status"] != 502 {
		t.Errorf("http_status: %v", m["http_status"])
	}
	if m["retryable"] != true {
		t.Errorf("retryable: %v", m["retryable"])
	}
	if _, ok := m["at"].(string); !ok {
		t.Errorf("at should be string: %#v", m["at"])
	}
}

func TestFromMap_RoundTripsFullPayload(t *testing.T) {
	original := NewError(CategoryDependency).
		Code("POSTGRES_DOWN").
		Message("db down").
		Description("long story").
		Remediation("restart it").
		Retryable(false).
		RetryAfterMs(5_000).
		Details(map[string]interface{}{"sql_state": "08001"}).
		HTTPStatus(503).
		Node("step-1").
		Build()

	// Round-trip via JSON to simulate cross-language transport.
	encoded, err := json.Marshal(original.ToMap())
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}

	rebuilt := FromMap(decoded)
	if rebuilt.Category != CategoryDependency {
		t.Errorf("category: %s", rebuilt.Category)
	}
	if rebuilt.Code != "POSTGRES_DOWN" {
		t.Errorf("code: %s", rebuilt.Code)
	}
	if rebuilt.Message != "db down" {
		t.Errorf("message: %s", rebuilt.Message)
	}
	if rebuilt.Description != "long story" {
		t.Errorf("description: %s", rebuilt.Description)
	}
	if rebuilt.HTTPStatus != 503 {
		t.Errorf("http_status: %d", rebuilt.HTTPStatus)
	}
	if rebuilt.RetryAfterMs != 5_000 {
		t.Errorf("retry_after_ms: %d", rebuilt.RetryAfterMs)
	}
}

func TestFromMap_HandlesCamelCaseAndUnknownCategories(t *testing.T) {
	payload := map[string]interface{}{
		"code":            "X",
		"category":        "weird-category", // → INTERNAL fallback
		"severity":        "huh",            // → ERROR fallback
		"message":         "m",
		"httpStatus":      418,
		"retryAfterMs":    int64(1000),
		"sdkVersion":      "9.9.9",
		"runtimeKind":     "runtime.go",
		"docUrl":          "https://example.com",
		"contextSnapshot": map[string]interface{}{"x": 1},
	}
	err := FromMap(payload)
	if err.Category != CategoryInternal {
		t.Errorf("category: %s", err.Category)
	}
	if err.Severity != SeverityError {
		t.Errorf("severity: %s", err.Severity)
	}
	if err.HTTPStatus != 418 {
		t.Errorf("http_status: %d", err.HTTPStatus)
	}
	if err.SDKVersion != "9.9.9" {
		t.Errorf("sdk_version: %s", err.SDKVersion)
	}
	if err.DocURL != "https://example.com" {
		t.Errorf("doc_url: %s", err.DocURL)
	}
}

// =============================================================================
// Cause chain
// =============================================================================

func TestCauseChain_WrapsPlainError(t *testing.T) {
	err := NewError(CategoryDependency).
		Code("X").
		Message("outer").
		Cause(errors.New("inner")).
		Build()
	if len(err.Causes) != 1 {
		t.Fatalf("expected 1 cause, got %d", len(err.Causes))
	}
	if err.Causes[0]["message"] != "inner" {
		t.Errorf("cause message: %v", err.Causes[0]["message"])
	}
}

func TestCauseChain_BlokErrorAsCauseFlattens(t *testing.T) {
	leaf := NewError(CategoryDependency).
		Code("LEAF").
		Message("leaf").
		Cause(errors.New("root")).
		Build()
	middle := NewError(CategoryDependency).
		Code("MID").
		Message("mid").
		Cause(leaf).
		Build()

	// `middle.Causes` should contain leaf's payload + leaf's flattened causes,
	// NOT a single nested cause object with cause inside cause.
	if len(middle.Causes) != 2 {
		t.Fatalf("expected 2 flat causes, got %d", len(middle.Causes))
	}
	if middle.Causes[0]["code"] != "LEAF" {
		t.Errorf("first cause code: %v", middle.Causes[0]["code"])
	}
	if c, ok := middle.Causes[0]["causes"].([]interface{}); !ok || len(c) != 0 {
		t.Errorf("nested cause list should be empty: %#v", middle.Causes[0]["causes"])
	}
}

// =============================================================================
// BuildContextSnapshot
// =============================================================================

func TestBuildContextSnapshot_EmptyInputsAndVars(t *testing.T) {
	snap := BuildContextSnapshot(map[string]interface{}{}, map[string]interface{}{})
	if len(snap) != 2 {
		t.Errorf("snapshot should have inputs+vars: %#v", snap)
	}
}

func TestBuildContextSnapshot_TrimsWhenOversized(t *testing.T) {
	bigVars := make(map[string]interface{}, 30)
	for i := 0; i < 30; i++ {
		bigVars[string(rune('a'+i))+string(rune('a'+i))] = strings.Repeat("x", 200)
	}
	snap := BuildContextSnapshotWithOpts(
		map[string]interface{}{"shape": "round"},
		bigVars,
		1024,
		30,
	)
	encoded, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > 1024 {
		t.Errorf("snapshot exceeds 1024 bytes: %d", len(encoded))
	}
	if inputs, ok := snap["inputs"].(map[string]interface{}); !ok || inputs["shape"] != "round" {
		t.Errorf("inputs not preserved: %#v", snap["inputs"])
	}
}

// =============================================================================
// Auto-enrichment defaults
// =============================================================================

func TestDefaultOrigin_PopulatesSdkConstants(t *testing.T) {
	o := DefaultOrigin("step-x", "1.2.3")
	if o.SDK != DefaultSDKName {
		t.Errorf("SDK: %s want %s", o.SDK, DefaultSDKName)
	}
	if DefaultSDKName != "blok-go" {
		t.Errorf("DefaultSDKName: %s want blok-go", DefaultSDKName)
	}
	if o.RuntimeKind != DefaultRuntimeKind {
		t.Errorf("RuntimeKind: %s want %s", o.RuntimeKind, DefaultRuntimeKind)
	}
	if DefaultRuntimeKind != "runtime.go" {
		t.Errorf("DefaultRuntimeKind: %s want runtime.go", DefaultRuntimeKind)
	}
	if o.Node != "step-x" {
		t.Errorf("Node: %s", o.Node)
	}
	if o.SDKVersion != "1.2.3" {
		t.Errorf("SDKVersion: %s", o.SDKVersion)
	}
}
