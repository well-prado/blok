// Package blok provides the Blok runtime SDK for Go
package blok

import (
	"encoding/json"
	"fmt"
)

// Context represents the workflow execution context
type Context struct {
	ID           string                 `json:"id"`
	WorkflowName string                 `json:"workflow_name"`
	WorkflowPath string                 `json:"workflow_path"`
	Request      Request                `json:"request"`
	Response     Response               `json:"response"`
	Vars         map[string]interface{} `json:"vars"`
	Env          map[string]string      `json:"env"`
}

// Request represents the incoming HTTP request data
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

// Response represents the workflow response
type Response struct {
	Data        interface{} `json:"data"`
	ContentType string      `json:"contentType"`
	Success     bool        `json:"success"`
	Error       interface{} `json:"error"`
}

// NodeConfig represents node-specific configuration
type NodeConfig struct {
	Name   string                 `json:"name"`
	Path   string                 `json:"path"`
	Config map[string]interface{} `json:"config"`
}

// ExecutionRequest is the request received from the Blok runner
type ExecutionRequest struct {
	Node    NodeConfig `json:"node"`
	Context Context    `json:"context"`
}

// ExecutionResult is the response returned to the Blok runner
type ExecutionResult struct {
	Success bool                   `json:"success"`
	Data    interface{}            `json:"data"`
	Errors  interface{}            `json:"errors"`
	Logs    []string               `json:"logs,omitempty"`
	Metrics map[string]interface{} `json:"metrics,omitempty"`
}

// NodeHandler is the interface that all Blok nodes must implement
type NodeHandler interface {
	Execute(ctx *Context, config map[string]interface{}) (interface{}, error)
}

// NodeRegistry manages registered node handlers
type NodeRegistry struct {
	nodes map[string]NodeHandler
}

// NewNodeRegistry creates a new node registry
func NewNodeRegistry() *NodeRegistry {
	return &NodeRegistry{
		nodes: make(map[string]NodeHandler),
	}
}

// Register registers a node handler with the given name
func (r *NodeRegistry) Register(name string, handler NodeHandler) {
	r.nodes[name] = handler
}

// Get retrieves a node handler by name
func (r *NodeRegistry) Get(name string) (NodeHandler, error) {
	handler, exists := r.nodes[name]
	if !exists {
		return nil, fmt.Errorf("node '%s' not found", name)
	}
	return handler, nil
}

// Execute executes a node by name
func (r *NodeRegistry) Execute(req *ExecutionRequest) *ExecutionResult {
	handler, err := r.Get(req.Node.Name)
	if err != nil {
		return &ExecutionResult{
			Success: false,
			Data:    nil,
			Errors: map[string]string{
				"message": err.Error(),
			},
		}
	}

	data, err := handler.Execute(&req.Context, req.Node.Config)
	if err != nil {
		return &ExecutionResult{
			Success: false,
			Data:    nil,
			Errors: map[string]string{
				"message": err.Error(),
			},
		}
	}

	return &ExecutionResult{
		Success: true,
		Data:    data,
		Errors:  nil,
	}
}

// HealthStatus represents the health status of the runtime
type HealthStatus struct {
	Status      string   `json:"status"`
	Version     string   `json:"version"`
	NodesLoaded []string `json:"nodes_loaded"`
}

// GetHealth returns the health status
func (r *NodeRegistry) GetHealth(version string) *HealthStatus {
	nodes := make([]string, 0, len(r.nodes))
	for name := range r.nodes {
		nodes = append(nodes, name)
	}

	return &HealthStatus{
		Status:      "healthy",
		Version:     version,
		NodesLoaded: nodes,
	}
}

// Helper function to parse JSON body into a struct
func ParseBody(body interface{}, target interface{}) error {
	bytes, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes, target)
}
