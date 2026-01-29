package nodes

import (
	"fmt"
	"time"

	nanoservice "github.com/nickincloud/nanoservice-go"
)

// HelloWorldNode is a simple example node that greets the user.
type HelloWorldNode struct{}

// Execute processes the hello-world node.
func (n *HelloWorldNode) Execute(ctx *nanoservice.Context, config map[string]interface{}) (interface{}, error) {
	// Get name from request body, default to "World"
	name := "World"
	if body := ctx.Request.BodyMap(); body != nil {
		if v, ok := body["name"].(string); ok && v != "" {
			name = v
		}
	}

	// Get prefix from config, default to "Hello"
	prefix := "Hello"
	if config != nil {
		if v, ok := config["prefix"].(string); ok && v != "" {
			prefix = v
		}
	}

	message := fmt.Sprintf("%s, %s!", prefix, name)

	// Store greeting in context vars for downstream nodes
	ctx.SetVar("greeting", message)

	return map[string]interface{}{
		"message":   message,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"language":  "go",
	}, nil
}
