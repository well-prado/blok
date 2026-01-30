package blok

// NodeHandler is the interface that all Blok nodes must implement.
//
// Nodes receive the workflow context and node-specific configuration,
// execute their logic, and return data or an error.
//
// Example:
//
//	type MyNode struct{}
//
//	func (n *MyNode) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
//	    name := "World"
//	    if body := ctx.Request.BodyMap(); body != nil {
//	        if v, ok := body["name"].(string); ok {
//	            name = v
//	        }
//	    }
//	    return map[string]interface{}{"message": "Hello, " + name + "!"}, nil
//	}
type NodeHandler interface {
	Execute(ctx *Context, config map[string]interface{}) (interface{}, error)
}

// NodeHandlerFunc is an adapter to allow ordinary functions to be used as NodeHandler.
//
// Example:
//
//	registry.Register("greet", blok.NodeHandlerFunc(func(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
//	    return map[string]string{"message": "Hello!"}, nil
//	}))
type NodeHandlerFunc func(ctx *Context, config map[string]interface{}) (interface{}, error)

// Execute calls the underlying function.
func (f NodeHandlerFunc) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
	return f(ctx, config)
}

// ValidatedNodeHandler is a NodeHandler that also declares input/output schemas for validation.
type ValidatedNodeHandler interface {
	NodeHandler

	// InputSchema returns the JSON Schema for validating input (request body).
	// Return nil to skip input validation.
	InputSchema() map[string]interface{}

	// OutputSchema returns the JSON Schema for validating output (result data).
	// Return nil to skip output validation.
	OutputSchema() map[string]interface{}
}
