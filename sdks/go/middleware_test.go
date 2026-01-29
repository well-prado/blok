package nanoservice

import (
	"errors"
	"testing"
	"time"
)

func TestLoggingMiddleware(t *testing.T) {
	logger := NewLogger(LogLevelDebug)
	mw := LoggingMiddleware(logger)

	handler := &testNode{returnData: "hello"}
	wrapped := mw(handler)

	ctx := NewMockContext().WithWorkflow("test-wf", "/test").BuildPtr()
	result, err := wrapped.Execute(ctx, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "hello" {
		t.Errorf("expected 'hello', got %v", result)
	}

	entries := logger.Entries()
	if len(entries) < 2 {
		t.Fatalf("expected at least 2 log entries, got %d", len(entries))
	}
	if entries[0].Level != LogLevelInfo {
		t.Errorf("expected INFO level, got %v", entries[0].Level)
	}
}

func TestLoggingMiddlewareError(t *testing.T) {
	logger := NewLogger(LogLevelDebug)
	mw := LoggingMiddleware(logger)

	handler := &testNode{returnError: errors.New("test error")}
	wrapped := mw(handler)

	ctx := NewMockContext().BuildPtr()
	_, err := wrapped.Execute(ctx, nil)
	if err == nil {
		t.Fatal("expected error")
	}

	entries := logger.Entries()
	hasError := false
	for _, e := range entries {
		if e.Level == LogLevelError {
			hasError = true
			break
		}
	}
	if !hasError {
		t.Error("expected an ERROR log entry")
	}
}

func TestRecoveryMiddleware(t *testing.T) {
	mw := RecoveryMiddleware()

	panicHandler := NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
		panic("something bad happened")
	})

	wrapped := mw(panicHandler)

	ctx := NewMockContext().BuildPtr()
	result, err := wrapped.Execute(ctx, nil)

	if err == nil {
		t.Fatal("expected error from panic recovery")
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}

	var nodeErr *NodeError
	if !errors.As(err, &nodeErr) {
		t.Fatalf("expected NodeError, got %T", err)
	}
	if nodeErr.Category != ErrorCategoryExecution {
		t.Errorf("expected EXECUTION category, got %v", nodeErr.Category)
	}
}

func TestTimeoutMiddleware(t *testing.T) {
	mw := TimeoutMiddleware(50 * time.Millisecond)

	slowHandler := NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
		time.Sleep(200 * time.Millisecond)
		return "done", nil
	})

	wrapped := mw(slowHandler)

	ctx := NewMockContext().BuildPtr()
	_, err := wrapped.Execute(ctx, nil)

	if err == nil {
		t.Fatal("expected timeout error")
	}

	var nodeErr *NodeError
	if !errors.As(err, &nodeErr) {
		t.Fatalf("expected NodeError, got %T", err)
	}
	if nodeErr.Code != 504 {
		t.Errorf("expected code 504, got %d", nodeErr.Code)
	}
}

func TestTimeoutMiddlewareFastExecution(t *testing.T) {
	mw := TimeoutMiddleware(1 * time.Second)

	fastHandler := &testNode{returnData: "fast"}
	wrapped := mw(fastHandler)

	ctx := NewMockContext().BuildPtr()
	result, err := wrapped.Execute(ctx, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "fast" {
		t.Errorf("expected 'fast', got %v", result)
	}
}

func TestChain(t *testing.T) {
	var order []string

	mw1 := func(next NodeHandler) NodeHandler {
		return NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
			order = append(order, "mw1-before")
			result, err := next.Execute(ctx, config)
			order = append(order, "mw1-after")
			return result, err
		})
	}

	mw2 := func(next NodeHandler) NodeHandler {
		return NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
			order = append(order, "mw2-before")
			result, err := next.Execute(ctx, config)
			order = append(order, "mw2-after")
			return result, err
		})
	}

	combined := Chain(mw1, mw2)
	handler := combined(&testNode{returnData: "result"})

	ctx := NewMockContext().BuildPtr()
	handler.Execute(ctx, nil)

	expected := []string{"mw1-before", "mw2-before", "mw2-after", "mw1-after"}
	if len(order) != len(expected) {
		t.Fatalf("expected %d entries, got %d: %v", len(expected), len(order), order)
	}
	for i, v := range expected {
		if order[i] != v {
			t.Errorf("position %d: expected %q, got %q", i, v, order[i])
		}
	}
}

type validatedTestNode struct {
	inputSchema  map[string]interface{}
	outputSchema map[string]interface{}
	returnData   interface{}
}

func (n *validatedTestNode) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
	return n.returnData, nil
}
func (n *validatedTestNode) InputSchema() map[string]interface{}  { return n.inputSchema }
func (n *validatedTestNode) OutputSchema() map[string]interface{} { return n.outputSchema }

func TestValidationMiddleware(t *testing.T) {
	validator := NewSchemaValidator()
	mw := ValidationMiddleware(validator)

	node := &validatedTestNode{
		inputSchema: map[string]interface{}{
			"type":     "object",
			"required": []interface{}{"name"},
			"properties": map[string]interface{}{
				"name": map[string]interface{}{"type": "string"},
			},
		},
		returnData: map[string]string{"greeting": "hello"},
	}

	wrapped := mw(node)

	// Valid input
	ctx := NewMockContext().WithBody(map[string]interface{}{"name": "test"}).BuildPtr()
	result, err := wrapped.Execute(ctx, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Error("expected non-nil result")
	}

	// Invalid input (missing required field)
	ctx = NewMockContext().WithBody(map[string]interface{}{}).BuildPtr()
	_, err = wrapped.Execute(ctx, nil)
	if err == nil {
		t.Fatal("expected validation error")
	}

	var nodeErr *NodeError
	if !errors.As(err, &nodeErr) {
		t.Fatalf("expected NodeError, got %T", err)
	}
	if nodeErr.Category != ErrorCategoryValidation {
		t.Errorf("expected VALIDATION category, got %v", nodeErr.Category)
	}
}
