package nanoservice

import (
	"errors"
	"testing"
)

func TestNodeErrorError(t *testing.T) {
	err := NewExecutionError("something broke", errors.New("underlying cause"))

	s := err.Error()
	if s != "[EXECUTION] something broke: underlying cause" {
		t.Errorf("unexpected error string: %q", s)
	}
}

func TestNodeErrorWithoutCause(t *testing.T) {
	err := NewValidationError("bad input")

	s := err.Error()
	if s != "[VALIDATION] bad input" {
		t.Errorf("unexpected error string: %q", s)
	}
}

func TestNodeErrorUnwrap(t *testing.T) {
	cause := errors.New("root cause")
	err := NewExecutionError("wrapper", cause)

	unwrapped := errors.Unwrap(err)
	if unwrapped != cause {
		t.Errorf("expected unwrapped to be root cause, got %v", unwrapped)
	}
}

func TestNodeErrorToMap(t *testing.T) {
	err := &NodeError{
		Message:  "test error",
		Code:     400,
		Category: ErrorCategoryValidation,
		Details:  map[string]interface{}{"field": "name"},
		Cause:    errors.New("cause"),
	}

	m := err.ToMap()

	if m["message"] != "test error" {
		t.Errorf("expected 'test error', got %v", m["message"])
	}
	if m["code"] != 400 {
		t.Errorf("expected 400, got %v", m["code"])
	}
	if m["category"] != "VALIDATION" {
		t.Errorf("expected 'VALIDATION', got %v", m["category"])
	}
	if m["details"] == nil {
		t.Error("expected details to be present")
	}
	if m["cause"] != "cause" {
		t.Errorf("expected 'cause', got %v", m["cause"])
	}
}

func TestErrorFactories(t *testing.T) {
	tests := []struct {
		name     string
		err      *NodeError
		category ErrorCategory
		code     int
	}{
		{"validation", NewValidationError("bad"), ErrorCategoryValidation, 400},
		{"execution", NewExecutionError("fail", nil), ErrorCategoryExecution, 500},
		{"configuration", NewConfigurationError("bad config"), ErrorCategoryConfiguration, 500},
		{"network", NewNetworkError("timeout", nil), ErrorCategoryNetwork, 502},
		{"not found", NewNotFoundError("missing"), ErrorCategoryNotFound, 404},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err.Category != tt.category {
				t.Errorf("expected category %v, got %v", tt.category, tt.err.Category)
			}
			if tt.err.Code != tt.code {
				t.Errorf("expected code %d, got %d", tt.code, tt.err.Code)
			}
		})
	}
}

func TestNodeErrorIsError(t *testing.T) {
	var err error = NewValidationError("test")
	if err == nil {
		t.Error("NodeError should implement error interface")
	}
}
