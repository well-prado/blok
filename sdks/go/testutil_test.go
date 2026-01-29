package nanoservice

import "testing"

func TestMockContextBuilder(t *testing.T) {
	ctx := NewMockContext().
		WithID("custom-id").
		WithWorkflow("my-workflow", "/workflows/mine").
		WithBody(map[string]interface{}{"name": "test"}).
		WithHeaders(map[string]string{"Authorization": "Bearer token"}).
		WithParams(map[string]string{"id": "123"}).
		WithQuery(map[string]string{"page": "1"}).
		WithMethod("GET").
		WithURL("/api/test").
		WithVar("key", "value").
		WithEnvVar("NODE_ENV", "test").
		Build()

	if ctx.ID != "custom-id" {
		t.Errorf("expected 'custom-id', got %q", ctx.ID)
	}
	if ctx.WorkflowName != "my-workflow" {
		t.Errorf("expected 'my-workflow', got %q", ctx.WorkflowName)
	}
	if ctx.Request.Method != "GET" {
		t.Errorf("expected 'GET', got %q", ctx.Request.Method)
	}

	body := ctx.Request.BodyMap()
	if body["name"] != "test" {
		t.Errorf("expected body name 'test', got %v", body["name"])
	}

	if ctx.Vars["key"] != "value" {
		t.Errorf("expected var 'key' = 'value'")
	}
	if ctx.Env["NODE_ENV"] != "test" {
		t.Errorf("expected env 'NODE_ENV' = 'test'")
	}
}

func TestMockContextBuilderDefaults(t *testing.T) {
	ctx := NewMockContext().Build()

	if ctx.ID == "" {
		t.Error("expected default ID")
	}
	if ctx.WorkflowName == "" {
		t.Error("expected default workflow name")
	}
	if ctx.Request.Method != "POST" {
		t.Errorf("expected default method 'POST', got %q", ctx.Request.Method)
	}
}

func TestMockContextBuildPtr(t *testing.T) {
	ptr := NewMockContext().BuildPtr()
	if ptr == nil {
		t.Fatal("expected non-nil pointer")
	}
	if ptr.ID == "" {
		t.Error("expected non-empty ID")
	}
}

func TestTestNodeRunner(t *testing.T) {
	runner := NewTestNodeRunner()
	runner.Register("greet", NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
		return map[string]string{"message": "hello"}, nil
	}))

	ctx := NewMockContext().Build()
	result := runner.Execute("greet", ctx, nil)

	if !result.Success {
		t.Errorf("expected success, got errors: %v", result.Errors)
	}
}

func TestTestNodeRunnerNotFound(t *testing.T) {
	runner := NewTestNodeRunner()
	ctx := NewMockContext().Build()
	result := runner.Execute("missing", ctx, nil)

	if result.Success {
		t.Error("expected failure for missing node")
	}
}

func TestAssertSuccess(t *testing.T) {
	result := NewSuccessResult("data")
	data, err := AssertSuccess(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data != "data" {
		t.Errorf("expected 'data', got %v", data)
	}

	// Should fail for error result
	errResult := NewErrorResult("fail")
	_, err = AssertSuccess(errResult)
	if err == nil {
		t.Error("expected error for failed result")
	}
}

func TestAssertError(t *testing.T) {
	result := NewErrorResult("fail")
	errInfo, err := AssertError(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if errInfo == nil {
		t.Error("expected error info")
	}

	// Should fail for success result
	successResult := NewSuccessResult("data")
	_, err = AssertError(successResult)
	if err == nil {
		t.Error("expected error for success result")
	}
}
