package helloworld

import (
	"fmt"
	"time"

	"github.com/deskree-inc/blok/examples/runtimes/go/sdk"
)

// HelloWorldNode is an example Blok node in Go
type HelloWorldNode struct{}

// Execute implements the NodeHandler interface
func (n *HelloWorldNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	// Get name from request body or use default
	name := "World"

	if ctx.Request.Body != nil {
		if bodyMap, ok := ctx.Request.Body.(map[string]interface{}); ok {
			if nameValue, ok := bodyMap["name"].(string); ok {
				name = nameValue
			}
		}
	}

	// Get greeting prefix from config or use default
	prefix := "Hello"
	if prefixValue, ok := config["prefix"].(string); ok {
		prefix = prefixValue
	}

	message := fmt.Sprintf("%s, %s!", prefix, name)

	// Store in context vars for downstream nodes
	ctx.Vars["greeting"] = message
	ctx.Vars["timestamp"] = time.Now().Unix()

	// Return response
	return map[string]interface{}{
		"message":   message,
		"timestamp": time.Now().Format(time.RFC3339),
		"language":  "Go",
	}, nil
}

// GetNodeHandler returns the node handler for registration
func GetNodeHandler() blok.NodeHandler {
	return &HelloWorldNode{}
}
