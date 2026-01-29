// Package nanoservice provides the Blok nanoservice runtime SDK for Go.
//
// This SDK enables building workflow nodes that integrate with the Blok
// orchestration framework. Nodes communicate via HTTP (POST /execute, GET /health)
// and can be deployed as Docker containers.
package nanoservice

import (
	"encoding/json"
	"fmt"
)

// Context represents the workflow execution context passed between nodes.
type Context struct {
	ID           string                 `json:"id"`
	WorkflowName string                 `json:"workflow_name"`
	WorkflowPath string                 `json:"workflow_path"`
	Request      Request                `json:"request"`
	Response     Response               `json:"response"`
	Vars         map[string]interface{} `json:"vars"`
	Env          map[string]string      `json:"env"`
}

// SetVar stores a variable in the context for downstream nodes.
func (c *Context) SetVar(key string, value interface{}) {
	if c.Vars == nil {
		c.Vars = make(map[string]interface{})
	}
	c.Vars[key] = value
}

// GetVar retrieves a variable from the context.
func (c *Context) GetVar(key string) (interface{}, bool) {
	if c.Vars == nil {
		return nil, false
	}
	v, ok := c.Vars[key]
	return v, ok
}

// GetVarString retrieves a string variable from the context.
func (c *Context) GetVarString(key string) string {
	v, ok := c.GetVar(key)
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

// Request represents the incoming HTTP request data.
type Request struct {
	Body    interface{}       `json:"body"`
	Headers map[string]string `json:"headers"`
	Params  map[string]string `json:"params"`
	Query   map[string]string `json:"query"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Cookies map[string]string `json:"cookies"`
	BaseURL string            `json:"baseUrl"`
}

// BodyAs unmarshals the request body into the target struct.
func (r *Request) BodyAs(target interface{}) error {
	bytes, err := json.Marshal(r.Body)
	if err != nil {
		return fmt.Errorf("failed to marshal body: %w", err)
	}
	return json.Unmarshal(bytes, target)
}

// BodyMap returns the request body as a map, or nil if not a map.
func (r *Request) BodyMap() map[string]interface{} {
	m, _ := r.Body.(map[string]interface{})
	return m
}

// Response represents the workflow response.
type Response struct {
	Data        interface{} `json:"data"`
	ContentType string      `json:"contentType"`
	Success     bool        `json:"success"`
	Error       interface{} `json:"error"`
}

// NodeConfig represents node-specific configuration from the runner.
type NodeConfig struct {
	Name   string                 `json:"name"`
	Type   string                 `json:"type,omitempty"`
	Path   string                 `json:"path,omitempty"`
	Config map[string]interface{} `json:"config"`
}

// GetConfigString retrieves a string config value with a default.
func (nc *NodeConfig) GetConfigString(key, defaultVal string) string {
	if nc.Config == nil {
		return defaultVal
	}
	v, ok := nc.Config[key]
	if !ok {
		return defaultVal
	}
	s, ok := v.(string)
	if !ok {
		return defaultVal
	}
	return s
}

// GetConfigInt retrieves an integer config value with a default.
func (nc *NodeConfig) GetConfigInt(key string, defaultVal int) int {
	if nc.Config == nil {
		return defaultVal
	}
	v, ok := nc.Config[key]
	if !ok {
		return defaultVal
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return defaultVal
	}
}

// GetConfigBool retrieves a boolean config value with a default.
func (nc *NodeConfig) GetConfigBool(key string, defaultVal bool) bool {
	if nc.Config == nil {
		return defaultVal
	}
	v, ok := nc.Config[key]
	if !ok {
		return defaultVal
	}
	b, ok := v.(bool)
	if !ok {
		return defaultVal
	}
	return b
}

// ExecutionRequest is the request received from the Blok runner.
type ExecutionRequest struct {
	Node    NodeConfig `json:"node"`
	Context Context    `json:"context"`
}

// ExecutionResult is the response returned to the Blok runner.
type ExecutionResult struct {
	Success bool              `json:"success"`
	Data    interface{}       `json:"data"`
	Errors  interface{}       `json:"errors"`
	Logs    []string          `json:"logs,omitempty"`
	Metrics *ExecutionMetrics `json:"metrics,omitempty"`
}

// NewSuccessResult creates a successful execution result.
func NewSuccessResult(data interface{}) *ExecutionResult {
	return &ExecutionResult{
		Success: true,
		Data:    data,
		Errors:  nil,
	}
}

// NewErrorResult creates a failed execution result.
func NewErrorResult(message string) *ExecutionResult {
	return &ExecutionResult{
		Success: false,
		Data:    nil,
		Errors: map[string]string{
			"message": message,
		},
	}
}

// NewErrorResultWithDetails creates a failed execution result with additional details.
func NewErrorResultWithDetails(message string, details map[string]interface{}) *ExecutionResult {
	return &ExecutionResult{
		Success: false,
		Data:    nil,
		Errors: map[string]interface{}{
			"message": message,
			"details": details,
		},
	}
}

// WithLogs adds log entries to the result.
func (r *ExecutionResult) WithLogs(logs []string) *ExecutionResult {
	r.Logs = logs
	return r
}

// WithMetrics adds execution metrics to the result.
func (r *ExecutionResult) WithMetrics(metrics *ExecutionMetrics) *ExecutionResult {
	r.Metrics = metrics
	return r
}

// ExecutionMetrics captures performance metrics for a node execution.
type ExecutionMetrics struct {
	DurationMs  *float64 `json:"duration_ms,omitempty"`
	CpuMs       *float64 `json:"cpu_ms,omitempty"`
	MemoryBytes *uint64  `json:"memory_bytes,omitempty"`
}

// HealthStatus represents the health status of the runtime.
type HealthStatus struct {
	Status      string   `json:"status"`
	Version     string   `json:"version"`
	NodesLoaded []string `json:"nodes_loaded"`
}

// ParseBody is a helper to unmarshal a generic body into a typed struct.
func ParseBody(body interface{}, target interface{}) error {
	bytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to marshal body: %w", err)
	}
	return json.Unmarshal(bytes, target)
}

// Float64Ptr returns a pointer to a float64 value.
func Float64Ptr(v float64) *float64 {
	return &v
}

// Uint64Ptr returns a pointer to a uint64 value.
func Uint64Ptr(v uint64) *uint64 {
	return &v
}
