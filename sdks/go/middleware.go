package blok

import (
	"fmt"
	"runtime/debug"
	"time"
)

// Middleware wraps a NodeHandler to add cross-cutting behavior.
// Middleware receives the next handler and returns a wrapped handler.
type Middleware func(NodeHandler) NodeHandler

// Chain composes multiple middleware into a single middleware.
// Middleware is applied in order: first middleware is outermost.
func Chain(middlewares ...Middleware) Middleware {
	return func(final NodeHandler) NodeHandler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			final = middlewares[i](final)
		}
		return final
	}
}

// LoggingMiddleware logs the execution of each node with timing.
func LoggingMiddleware(logger *Logger) Middleware {
	return func(next NodeHandler) NodeHandler {
		return NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
			start := time.Now()
			logger.Info("node execution started", map[string]interface{}{
				"workflow": ctx.WorkflowName,
			})

			result, err := next.Execute(ctx, config)

			duration := time.Since(start)
			fields := map[string]interface{}{
				"workflow":    ctx.WorkflowName,
				"duration_ms": float64(duration.Microseconds()) / 1000.0,
			}

			if err != nil {
				fields["error"] = err.Error()
				logger.Error("node execution failed", fields)
			} else {
				logger.Info("node execution completed", fields)
			}

			return result, err
		})
	}
}

// RecoveryMiddleware catches panics during node execution and converts them to errors.
func RecoveryMiddleware() Middleware {
	return func(next NodeHandler) NodeHandler {
		return NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (result interface{}, err error) {
			defer func() {
				if r := recover(); r != nil {
					stack := string(debug.Stack())
					err = &NodeError{
						Message:  fmt.Sprintf("panic recovered: %v", r),
						Code:     500,
						Category: ErrorCategoryExecution,
						Details: map[string]interface{}{
							"stack": stack,
						},
					}
				}
			}()
			return next.Execute(ctx, config)
		})
	}
}

// TimeoutMiddleware enforces a maximum execution duration.
func TimeoutMiddleware(timeout time.Duration) Middleware {
	return func(next NodeHandler) NodeHandler {
		return NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
			type result struct {
				data interface{}
				err  error
			}

			done := make(chan result, 1)
			go func() {
				data, err := next.Execute(ctx, config)
				done <- result{data, err}
			}()

			select {
			case r := <-done:
				return r.data, r.err
			case <-time.After(timeout):
				return nil, &NodeError{
					Message:  fmt.Sprintf("execution timed out after %v", timeout),
					Code:     504,
					Category: ErrorCategoryExecution,
				}
			}
		})
	}
}

// ValidationMiddleware validates input and output against schemas
// if the node implements ValidatedNodeHandler.
func ValidationMiddleware(validator *SchemaValidator) Middleware {
	return func(next NodeHandler) NodeHandler {
		return NodeHandlerFunc(func(ctx *Context, config map[string]interface{}) (interface{}, error) {
			// Check if the handler supports validation
			validated, ok := next.(ValidatedNodeHandler)
			if !ok {
				return next.Execute(ctx, config)
			}

			// Validate input
			if inputSchema := validated.InputSchema(); inputSchema != nil {
				if errs := validator.Validate(ctx.Request.Body, inputSchema); len(errs) > 0 {
					return nil, &NodeError{
						Message:  "input validation failed",
						Code:     400,
						Category: ErrorCategoryValidation,
						Details: map[string]interface{}{
							"errors": errs,
						},
					}
				}
			}

			// Execute node
			result, err := next.Execute(ctx, config)
			if err != nil {
				return nil, err
			}

			// Validate output
			if outputSchema := validated.OutputSchema(); outputSchema != nil {
				if errs := validator.Validate(result, outputSchema); len(errs) > 0 {
					return nil, &NodeError{
						Message:  "output validation failed",
						Code:     500,
						Category: ErrorCategoryValidation,
						Details: map[string]interface{}{
							"errors": errs,
						},
					}
				}
			}

			return result, nil
		})
	}
}
