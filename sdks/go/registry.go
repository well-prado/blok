package blok

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

// NodeRegistry manages registered node handlers and executes them.
type NodeRegistry struct {
	mu         sync.RWMutex
	nodes      map[string]NodeHandler
	middleware []Middleware
	validator  *SchemaValidator
}

// NewNodeRegistry creates a new node registry.
func NewNodeRegistry() *NodeRegistry {
	return &NodeRegistry{
		nodes:     make(map[string]NodeHandler),
		validator: NewSchemaValidator(),
	}
}

// Register registers a node handler with the given name.
func (r *NodeRegistry) Register(name string, handler NodeHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nodes[name] = handler
}

// Use adds middleware to the registry. Middleware is applied to all node
// executions in the order added.
func (r *NodeRegistry) Use(mw ...Middleware) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.middleware = append(r.middleware, mw...)
}

// Get retrieves a node handler by name.
func (r *NodeRegistry) Get(name string) (NodeHandler, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	handler, exists := r.nodes[name]
	if !exists {
		return nil, NewNotFoundError(fmt.Sprintf("node '%s' not found", name))
	}
	return handler, nil
}

// NodeNames returns the names of all registered nodes.
func (r *NodeRegistry) NodeNames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.nodes))
	for name := range r.nodes {
		names = append(names, name)
	}
	return names
}

// Execute executes a node by name with the given request.
// It applies all registered middleware and captures metrics.
func (r *NodeRegistry) Execute(req *ExecutionRequest) *ExecutionResult {
	start := time.Now()
	var memBefore uint64
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	memBefore = memStats.Alloc

	// Look up handler
	handler, err := r.Get(req.Node.Name)
	if err != nil {
		return NewErrorResult(err.Error())
	}

	// Apply middleware chain
	r.mu.RLock()
	middlewares := make([]Middleware, len(r.middleware))
	copy(middlewares, r.middleware)
	r.mu.RUnlock()

	if len(middlewares) > 0 {
		handler = Chain(middlewares...)(handler)
	}

	// Execute
	data, err := handler.Execute(&req.Context, req.Node.Config)

	// Calculate metrics
	duration := time.Since(start)
	runtime.ReadMemStats(&memStats)
	memAfter := memStats.Alloc
	var memUsed uint64
	if memAfter > memBefore {
		memUsed = memAfter - memBefore
	}

	durationMs := float64(duration.Microseconds()) / 1000.0

	if err != nil {
		errResult := &ExecutionResult{
			Success: false,
			Data:    nil,
			Metrics: &ExecutionMetrics{
				DurationMs:  Float64Ptr(durationMs),
				MemoryBytes: Uint64Ptr(memUsed),
			},
		}

		// Structured BlokError path (master plan §17): pass the instance
		// through verbatim so the gRPC servicer can serialize every field
		// (category, severity, remediation, retryable hints, cause chain,
		// context snapshot, etc.) into the proto NodeError.
		if blokErr, ok := err.(*BlokError); ok {
			errResult.Errors = blokErr
		} else if nodeErr, ok := err.(*NodeError); ok {
			errResult.Errors = nodeErr.ToMap()
		} else {
			errResult.Errors = map[string]string{
				"message": err.Error(),
			}
		}

		return errResult
	}

	result := &ExecutionResult{
		Success: true,
		Data:    data,
		Errors:  nil,
		Metrics: &ExecutionMetrics{
			DurationMs:  Float64Ptr(durationMs),
			MemoryBytes: Uint64Ptr(memUsed),
		},
	}

	// Include context vars so the runner can propagate them downstream
	if len(req.Context.Vars) > 0 {
		result.Vars = req.Context.Vars
	}

	return result
}

// Health returns the health status of the registry.
func (r *NodeRegistry) Health(version string) *HealthStatus {
	return &HealthStatus{
		Status:      "healthy",
		Version:     version,
		NodesLoaded: r.NodeNames(),
	}
}
