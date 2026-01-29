package nanoservice

import "fmt"

// MockContextBuilder provides a fluent API for building test contexts.
type MockContextBuilder struct {
	ctx Context
}

// NewMockContext starts building a mock context with sensible defaults.
func NewMockContext() *MockContextBuilder {
	return &MockContextBuilder{
		ctx: Context{
			ID:           "test-execution-id",
			WorkflowName: "test-workflow",
			WorkflowPath: "/workflows/test",
			Request: Request{
				Body:    map[string]interface{}{},
				Headers: map[string]string{},
				Params:  map[string]string{},
				Query:   map[string]string{},
				Method:  "POST",
				URL:     "/test",
				Cookies: map[string]string{},
				BaseURL: "http://localhost:8080",
			},
			Response: Response{
				Success: true,
			},
			Vars: map[string]interface{}{},
			Env:  map[string]string{},
		},
	}
}

// WithID sets the execution ID.
func (b *MockContextBuilder) WithID(id string) *MockContextBuilder {
	b.ctx.ID = id
	return b
}

// WithWorkflow sets the workflow name and path.
func (b *MockContextBuilder) WithWorkflow(name, path string) *MockContextBuilder {
	b.ctx.WorkflowName = name
	b.ctx.WorkflowPath = path
	return b
}

// WithBody sets the request body.
func (b *MockContextBuilder) WithBody(body interface{}) *MockContextBuilder {
	b.ctx.Request.Body = body
	return b
}

// WithHeaders sets the request headers.
func (b *MockContextBuilder) WithHeaders(headers map[string]string) *MockContextBuilder {
	b.ctx.Request.Headers = headers
	return b
}

// WithParams sets the request params.
func (b *MockContextBuilder) WithParams(params map[string]string) *MockContextBuilder {
	b.ctx.Request.Params = params
	return b
}

// WithQuery sets the request query parameters.
func (b *MockContextBuilder) WithQuery(query map[string]string) *MockContextBuilder {
	b.ctx.Request.Query = query
	return b
}

// WithMethod sets the request method.
func (b *MockContextBuilder) WithMethod(method string) *MockContextBuilder {
	b.ctx.Request.Method = method
	return b
}

// WithURL sets the request URL.
func (b *MockContextBuilder) WithURL(url string) *MockContextBuilder {
	b.ctx.Request.URL = url
	return b
}

// WithVars sets the context variables.
func (b *MockContextBuilder) WithVars(vars map[string]interface{}) *MockContextBuilder {
	b.ctx.Vars = vars
	return b
}

// WithVar sets a single context variable.
func (b *MockContextBuilder) WithVar(key string, value interface{}) *MockContextBuilder {
	if b.ctx.Vars == nil {
		b.ctx.Vars = make(map[string]interface{})
	}
	b.ctx.Vars[key] = value
	return b
}

// WithEnv sets the environment variables.
func (b *MockContextBuilder) WithEnv(env map[string]string) *MockContextBuilder {
	b.ctx.Env = env
	return b
}

// WithEnvVar sets a single environment variable.
func (b *MockContextBuilder) WithEnvVar(key, value string) *MockContextBuilder {
	if b.ctx.Env == nil {
		b.ctx.Env = make(map[string]string)
	}
	b.ctx.Env[key] = value
	return b
}

// Build returns the constructed context.
func (b *MockContextBuilder) Build() Context {
	return b.ctx
}

// BuildPtr returns a pointer to the constructed context.
func (b *MockContextBuilder) BuildPtr() *Context {
	ctx := b.ctx
	return &ctx
}

// TestNodeRunner executes a node in-process for testing.
type TestNodeRunner struct {
	registry *NodeRegistry
}

// NewTestNodeRunner creates a test node runner.
func NewTestNodeRunner() *TestNodeRunner {
	return &TestNodeRunner{
		registry: NewNodeRegistry(),
	}
}

// Register registers a node for testing.
func (r *TestNodeRunner) Register(name string, handler NodeHandler) *TestNodeRunner {
	r.registry.Register(name, handler)
	return r
}

// Execute runs a node by name with the given context and config.
func (r *TestNodeRunner) Execute(name string, ctx Context, config map[string]interface{}) *ExecutionResult {
	return r.registry.Execute(&ExecutionRequest{
		Node: NodeConfig{
			Name:   name,
			Config: config,
		},
		Context: ctx,
	})
}

// AssertSuccess checks that the result is successful and returns the data.
func AssertSuccess(result *ExecutionResult) (interface{}, error) {
	if !result.Success {
		return nil, fmt.Errorf("expected success but got error: %v", result.Errors)
	}
	return result.Data, nil
}

// AssertError checks that the result is an error and returns the error info.
func AssertError(result *ExecutionResult) (interface{}, error) {
	if result.Success {
		return nil, fmt.Errorf("expected error but got success with data: %v", result.Data)
	}
	return result.Errors, nil
}
