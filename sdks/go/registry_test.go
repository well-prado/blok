package blok

import (
	"errors"
	"testing"
)

// testNode is a simple node handler for tests.
type testNode struct {
	returnData  interface{}
	returnError error
}

func (n *testNode) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
	return n.returnData, n.returnError
}

func TestNodeRegistryRegisterAndGet(t *testing.T) {
	registry := NewNodeRegistry()
	handler := &testNode{returnData: "hello"}

	registry.Register("test-node", handler)

	got, err := registry.Get("test-node")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil {
		t.Fatal("expected non-nil handler")
	}
}

func TestNodeRegistryGetNotFound(t *testing.T) {
	registry := NewNodeRegistry()

	_, err := registry.Get("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent node")
	}

	var nodeErr *NodeError
	if !errors.As(err, &nodeErr) {
		t.Fatalf("expected NodeError, got %T", err)
	}
	if nodeErr.Category != ErrorCategoryNotFound {
		t.Errorf("expected NOT_FOUND category, got %v", nodeErr.Category)
	}
}

func TestNodeRegistryExecuteSuccess(t *testing.T) {
	registry := NewNodeRegistry()
	registry.Register("test-node", &testNode{
		returnData: map[string]string{"message": "hello"},
	})

	result := registry.Execute(&ExecutionRequest{
		Node: NodeConfig{
			Name:   "test-node",
			Config: map[string]interface{}{},
		},
		Context: NewMockContext().Build(),
	})

	if !result.Success {
		t.Errorf("expected success, got errors: %v", result.Errors)
	}
	if result.Data == nil {
		t.Error("expected non-nil data")
	}
	if result.Metrics == nil {
		t.Error("expected non-nil metrics")
	}
	if result.Metrics.DurationMs == nil {
		t.Error("expected duration_ms to be set")
	}
}

func TestNodeRegistryExecuteError(t *testing.T) {
	registry := NewNodeRegistry()
	registry.Register("error-node", &testNode{
		returnError: errors.New("execution failed"),
	})

	result := registry.Execute(&ExecutionRequest{
		Node: NodeConfig{
			Name:   "error-node",
			Config: map[string]interface{}{},
		},
		Context: NewMockContext().Build(),
	})

	if result.Success {
		t.Error("expected failure")
	}
	if result.Errors == nil {
		t.Error("expected non-nil errors")
	}
}

func TestNodeRegistryExecuteNodeNotFound(t *testing.T) {
	registry := NewNodeRegistry()

	result := registry.Execute(&ExecutionRequest{
		Node: NodeConfig{
			Name:   "missing-node",
			Config: map[string]interface{}{},
		},
		Context: NewMockContext().Build(),
	})

	if result.Success {
		t.Error("expected failure")
	}
}

func TestNodeRegistryNodeNames(t *testing.T) {
	registry := NewNodeRegistry()
	registry.Register("node-a", &testNode{})
	registry.Register("node-b", &testNode{})
	registry.Register("node-c", &testNode{})

	names := registry.NodeNames()
	if len(names) != 3 {
		t.Errorf("expected 3 names, got %d", len(names))
	}

	nameSet := make(map[string]bool)
	for _, n := range names {
		nameSet[n] = true
	}
	for _, expected := range []string{"node-a", "node-b", "node-c"} {
		if !nameSet[expected] {
			t.Errorf("missing node name: %s", expected)
		}
	}
}

func TestNodeRegistryHealth(t *testing.T) {
	registry := NewNodeRegistry()
	registry.Register("hello-world", &testNode{})
	registry.Register("api-call", &testNode{})

	health := registry.Health("2.0.0")

	if health.Status != "healthy" {
		t.Errorf("expected 'healthy', got %q", health.Status)
	}
	if health.Version != "2.0.0" {
		t.Errorf("expected '2.0.0', got %q", health.Version)
	}
	if len(health.NodesLoaded) != 2 {
		t.Errorf("expected 2 nodes, got %d", len(health.NodesLoaded))
	}
}

func TestNodeRegistryExecuteWithNodeError(t *testing.T) {
	registry := NewNodeRegistry()
	registry.Register("validation-node", &testNode{
		returnError: NewValidationError("invalid input"),
	})

	result := registry.Execute(&ExecutionRequest{
		Node: NodeConfig{
			Name:   "validation-node",
			Config: map[string]interface{}{},
		},
		Context: NewMockContext().Build(),
	})

	if result.Success {
		t.Error("expected failure")
	}

	errMap, ok := result.Errors.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map[string]interface{}, got %T", result.Errors)
	}
	if errMap["category"] != "VALIDATION" {
		t.Errorf("expected VALIDATION category, got %v", errMap["category"])
	}
}

func TestNodeHandlerFunc(t *testing.T) {
	handler := NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
		return "hello from func", nil
	})

	data, err := handler.Execute(&Context{}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data != "hello from func" {
		t.Errorf("expected 'hello from func', got %v", data)
	}
}
