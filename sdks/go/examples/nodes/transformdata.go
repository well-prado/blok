package nodes

import (
	"fmt"
	"strings"

	blok "github.com/nickincloud/blok-go"
)

// TransformDataNode transforms JSON data based on field mappings.
//
// Config:
//   - mappings (map[string]string): Field mapping from source to target.
//     Keys are target field names, values are source field paths (dot-notation).
//   - include_only ([]string, optional): If set, only include these fields from input.
//   - exclude ([]string, optional): Fields to exclude from output.
//   - defaults (map[string]any, optional): Default values for missing fields.
//
// Input (request body):
//   - The input data object to transform
//
// Output:
//   - The transformed data object
type TransformDataNode struct{}

// Execute performs the data transformation.
func (n *TransformDataNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	body := ctx.Request.BodyMap()
	if body == nil {
		return nil, blok.NewValidationError("request body must be a JSON object")
	}

	result := make(map[string]interface{})

	// Apply field mappings if configured
	if mappings, ok := config["mappings"].(map[string]interface{}); ok {
		for targetField, sourcePathRaw := range mappings {
			sourcePath, ok := sourcePathRaw.(string)
			if !ok {
				continue
			}
			value := getNestedValue(body, sourcePath)
			if value != nil {
				result[targetField] = value
			}
		}
	} else {
		// No mappings — copy all fields
		for k, v := range body {
			result[k] = v
		}
	}

	// Apply include_only filter
	if includeOnly, ok := config["include_only"].([]interface{}); ok && len(includeOnly) > 0 {
		filtered := make(map[string]interface{})
		for _, field := range includeOnly {
			fieldName, ok := field.(string)
			if !ok {
				continue
			}
			if v, exists := result[fieldName]; exists {
				filtered[fieldName] = v
			}
		}
		result = filtered
	}

	// Apply exclude filter
	if exclude, ok := config["exclude"].([]interface{}); ok {
		for _, field := range exclude {
			fieldName, ok := field.(string)
			if !ok {
				continue
			}
			delete(result, fieldName)
		}
	}

	// Apply defaults for missing fields
	if defaults, ok := config["defaults"].(map[string]interface{}); ok {
		for k, v := range defaults {
			if _, exists := result[k]; !exists {
				result[k] = v
			}
		}
	}

	// Store transformed data in vars
	ctx.SetVar("transformed_data", result)

	return result, nil
}

// getNestedValue retrieves a value from a nested map using dot-notation path.
func getNestedValue(data map[string]interface{}, path string) interface{} {
	parts := strings.Split(path, ".")
	var current interface{} = data

	for _, part := range parts {
		m, ok := current.(map[string]interface{})
		if !ok {
			return nil
		}
		current, ok = m[part]
		if !ok {
			return nil
		}
	}

	return current
}

// InputSchema returns the JSON Schema for validation.
func (n *TransformDataNode) InputSchema() map[string]interface{} {
	return map[string]interface{}{
		"type": "object",
	}
}

// OutputSchema returns the JSON Schema for validation.
func (n *TransformDataNode) OutputSchema() map[string]interface{} {
	return map[string]interface{}{
		"type": "object",
	}
}

// Ensure TransformDataNode implements ValidatedNodeHandler
var _ blok.ValidatedNodeHandler = (*TransformDataNode)(nil)

// compile-time interface check for other nodes
var _ blok.NodeHandler = (*HelloWorldNode)(nil)
var _ blok.NodeHandler = (*ApiCallNode)(nil)

// NodeName constants for registration.
const (
	HelloWorldNodeName    = "hello-world"
	ApiCallNodeName       = "api-call"
	TransformDataNodeName = "transform-data"
	ChainTestNodeName     = "chain-test"
)

// RegisterAll registers all example nodes with the registry.
func RegisterAll(registry *blok.NodeRegistry) {
	registry.Register(HelloWorldNodeName, &HelloWorldNode{})
	registry.Register(ApiCallNodeName, &ApiCallNode{})
	registry.Register(TransformDataNodeName, &TransformDataNode{})
	registry.Register(ChainTestNodeName, &ChainTestNode{})
}

// RegisterDefaults is an alias for RegisterAll for convenience.
func RegisterDefaults(registry *blok.NodeRegistry) {
	RegisterAll(registry)
}

// Describe returns a description of all example nodes.
func Describe() map[string]string {
	return map[string]string{
		HelloWorldNodeName:    "Greets the user with a configurable prefix and name",
		ApiCallNodeName:       "Makes HTTP requests to external APIs",
		TransformDataNodeName: "Transforms JSON data based on field mappings",
	}
}

// DescribeNode returns a description of a specific example node.
func DescribeNode(name string) (string, error) {
	descriptions := Describe()
	desc, ok := descriptions[name]
	if !ok {
		return "", fmt.Errorf("unknown example node: %s", name)
	}
	return desc, nil
}
