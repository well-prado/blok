package blok

import (
	"encoding/json"
	"testing"
)

func TestContextJSON(t *testing.T) {
	ctx := Context{
		ID:           "test-123",
		WorkflowName: "test-workflow",
		WorkflowPath: "/workflows/test",
		Request: Request{
			Body:    map[string]interface{}{"key": "value"},
			Headers: map[string]string{"Content-Type": "application/json"},
			Params:  map[string]string{"id": "1"},
			Query:   map[string]string{"page": "1"},
			Method:  "POST",
			URL:     "/api/test",
			Cookies: map[string]string{},
			BaseURL: "http://localhost:8080",
		},
		Response: Response{
			Success: true,
			Data:    nil,
		},
		Vars: map[string]interface{}{},
		Env:  map[string]string{"NODE_ENV": "test"},
	}

	// Marshal to JSON
	data, err := json.Marshal(ctx)
	if err != nil {
		t.Fatalf("failed to marshal context: %v", err)
	}

	// Unmarshal back
	var restored Context
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("failed to unmarshal context: %v", err)
	}

	if restored.ID != ctx.ID {
		t.Errorf("ID mismatch: got %q, want %q", restored.ID, ctx.ID)
	}
	if restored.WorkflowName != ctx.WorkflowName {
		t.Errorf("WorkflowName mismatch: got %q, want %q", restored.WorkflowName, ctx.WorkflowName)
	}
	if restored.Request.Method != ctx.Request.Method {
		t.Errorf("Method mismatch: got %q, want %q", restored.Request.Method, ctx.Request.Method)
	}
	if restored.Request.BaseURL != ctx.Request.BaseURL {
		t.Errorf("BaseURL mismatch: got %q, want %q", restored.Request.BaseURL, ctx.Request.BaseURL)
	}
}

func TestContextSetGetVar(t *testing.T) {
	ctx := &Context{}

	// Set var on nil map
	ctx.SetVar("key", "value")
	v, ok := ctx.GetVar("key")
	if !ok || v != "value" {
		t.Errorf("expected 'value', got %v (ok=%v)", v, ok)
	}

	// Get nonexistent
	_, ok = ctx.GetVar("missing")
	if ok {
		t.Error("expected ok=false for missing key")
	}

	// GetVarString
	ctx.SetVar("name", "test")
	s := ctx.GetVarString("name")
	if s != "test" {
		t.Errorf("expected 'test', got %q", s)
	}

	// GetVarString missing returns ""
	s = ctx.GetVarString("missing")
	if s != "" {
		t.Errorf("expected empty string, got %q", s)
	}
}

func TestRequestBodyAs(t *testing.T) {
	req := Request{
		Body: map[string]interface{}{
			"name": "World",
			"age":  float64(30),
		},
	}

	type bodyType struct {
		Name string  `json:"name"`
		Age  float64 `json:"age"`
	}

	var body bodyType
	if err := req.BodyAs(&body); err != nil {
		t.Fatalf("BodyAs failed: %v", err)
	}

	if body.Name != "World" {
		t.Errorf("expected 'World', got %q", body.Name)
	}
	if body.Age != 30 {
		t.Errorf("expected 30, got %v", body.Age)
	}
}

func TestRequestBodyMap(t *testing.T) {
	req := Request{
		Body: map[string]interface{}{"key": "value"},
	}
	m := req.BodyMap()
	if m == nil {
		t.Fatal("expected non-nil map")
	}
	if m["key"] != "value" {
		t.Errorf("expected 'value', got %v", m["key"])
	}

	// Non-map body returns nil
	req.Body = "not a map"
	m = req.BodyMap()
	if m != nil {
		t.Error("expected nil for non-map body")
	}
}

func TestNodeConfigHelpers(t *testing.T) {
	nc := NodeConfig{
		Name: "test",
		Config: map[string]interface{}{
			"prefix":  "Hi",
			"count":   float64(5),
			"enabled": true,
		},
	}

	if v := nc.GetConfigString("prefix", "default"); v != "Hi" {
		t.Errorf("expected 'Hi', got %q", v)
	}
	if v := nc.GetConfigString("missing", "default"); v != "default" {
		t.Errorf("expected 'default', got %q", v)
	}

	if v := nc.GetConfigInt("count", 0); v != 5 {
		t.Errorf("expected 5, got %d", v)
	}
	if v := nc.GetConfigInt("missing", 10); v != 10 {
		t.Errorf("expected 10, got %d", v)
	}

	if v := nc.GetConfigBool("enabled", false); !v {
		t.Error("expected true")
	}
	if v := nc.GetConfigBool("missing", false); v {
		t.Error("expected false for missing key")
	}
}

func TestExecutionResultJSON(t *testing.T) {
	tests := []struct {
		name   string
		result *ExecutionResult
	}{
		{
			name:   "success",
			result: NewSuccessResult(map[string]string{"message": "hello"}),
		},
		{
			name:   "error",
			result: NewErrorResult("something went wrong"),
		},
		{
			name: "success with metrics",
			result: NewSuccessResult("data").WithMetrics(&ExecutionMetrics{
				DurationMs:  Float64Ptr(12.5),
				MemoryBytes: Uint64Ptr(1024),
			}),
		},
		{
			name:   "success with logs",
			result: NewSuccessResult("data").WithLogs([]string{"log1", "log2"}),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.result)
			if err != nil {
				t.Fatalf("failed to marshal: %v", err)
			}

			var restored ExecutionResult
			if err := json.Unmarshal(data, &restored); err != nil {
				t.Fatalf("failed to unmarshal: %v", err)
			}

			if restored.Success != tt.result.Success {
				t.Errorf("Success mismatch: got %v, want %v", restored.Success, tt.result.Success)
			}
		})
	}
}

func TestHealthStatusJSON(t *testing.T) {
	health := HealthStatus{
		Status:      "healthy",
		Version:     "1.0.0",
		NodesLoaded: []string{"hello-world", "api-call"},
	}

	data, err := json.Marshal(health)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var restored HealthStatus
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if restored.Status != "healthy" {
		t.Errorf("expected 'healthy', got %q", restored.Status)
	}
	if len(restored.NodesLoaded) != 2 {
		t.Errorf("expected 2 nodes, got %d", len(restored.NodesLoaded))
	}
}

func TestParseBody(t *testing.T) {
	body := map[string]interface{}{
		"name": "test",
	}

	type target struct {
		Name string `json:"name"`
	}

	var result target
	if err := ParseBody(body, &result); err != nil {
		t.Fatalf("ParseBody failed: %v", err)
	}
	if result.Name != "test" {
		t.Errorf("expected 'test', got %q", result.Name)
	}
}
