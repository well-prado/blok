package nanoservice

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestServer() (*Server, *NodeRegistry) {
	registry := NewNodeRegistry()
	registry.Register("test-node", &testNode{
		returnData: map[string]string{"message": "hello"},
	})

	config := DefaultConfig()
	server := NewServer(registry, config)
	return server, registry
}

func TestHandleExecuteSuccess(t *testing.T) {
	server, _ := newTestServer()

	body := ExecutionRequest{
		Node: NodeConfig{
			Name:   "test-node",
			Config: map[string]interface{}{},
		},
		Context: NewMockContext().Build(),
	}
	bodyBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/execute", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.handleExecute(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var result ExecutionResult
	if err := json.NewDecoder(w.Body).Decode(&result); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !result.Success {
		t.Errorf("expected success, got errors: %v", result.Errors)
	}
}

func TestHandleExecuteInvalidJSON(t *testing.T) {
	server, _ := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/execute", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.handleExecute(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}

	var result ExecutionResult
	if err := json.NewDecoder(w.Body).Decode(&result); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if result.Success {
		t.Error("expected failure for invalid JSON")
	}
}

func TestHandleExecuteMethodNotAllowed(t *testing.T) {
	server, _ := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/execute", nil)
	w := httptest.NewRecorder()

	server.handleExecute(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleExecuteNodeNotFound(t *testing.T) {
	server, _ := newTestServer()

	body := ExecutionRequest{
		Node: NodeConfig{
			Name:   "nonexistent",
			Config: map[string]interface{}{},
		},
		Context: NewMockContext().Build(),
	}
	bodyBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/execute", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.handleExecute(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (error in body), got %d", w.Code)
	}

	var result ExecutionResult
	json.NewDecoder(w.Body).Decode(&result)
	if result.Success {
		t.Error("expected failure for nonexistent node")
	}
}

func TestHandleHealth(t *testing.T) {
	server, _ := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	server.handleHealth(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var health HealthStatus
	if err := json.NewDecoder(w.Body).Decode(&health); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if health.Status != "healthy" {
		t.Errorf("expected 'healthy', got %q", health.Status)
	}
	if len(health.NodesLoaded) != 1 {
		t.Errorf("expected 1 node, got %d", len(health.NodesLoaded))
	}
}

func TestHandleHealthMethodNotAllowed(t *testing.T) {
	server, _ := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	w := httptest.NewRecorder()

	server.handleHealth(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestCORSHandler(t *testing.T) {
	server, _ := newTestServer()
	server.config.EnableCORS = true

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := server.corsHandler(inner)

	// Test OPTIONS preflight
	req := httptest.NewRequest(http.MethodOptions, "/execute", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204 for OPTIONS, got %d", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("expected CORS header")
	}

	// Test normal request gets CORS headers
	req = httptest.NewRequest(http.MethodPost, "/execute", nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("expected CORS header on normal request")
	}
}
