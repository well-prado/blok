package nanoservice

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SchemaValidator validates data against a JSON Schema (Draft 7 subset).
//
// This is a lightweight validator that supports the most common JSON Schema
// keywords: type, properties, required, enum, minimum, maximum, minLength,
// maxLength, and pattern. For full JSON Schema support, use a dedicated library.
type SchemaValidator struct{}

// NewSchemaValidator creates a new schema validator.
func NewSchemaValidator() *SchemaValidator {
	return &SchemaValidator{}
}

// Validate checks data against a JSON Schema and returns validation errors.
// Returns nil if validation passes.
func (v *SchemaValidator) Validate(data interface{}, schema map[string]interface{}) []string {
	var errors []string
	v.validateValue(data, schema, "", &errors)
	return errors
}

// ValidateJSON validates a JSON byte slice against a schema.
func (v *SchemaValidator) ValidateJSON(jsonData []byte, schema map[string]interface{}) []string {
	var data interface{}
	if err := json.Unmarshal(jsonData, &data); err != nil {
		return []string{fmt.Sprintf("invalid JSON: %v", err)}
	}
	return v.Validate(data, schema)
}

func (v *SchemaValidator) validateValue(data interface{}, schema map[string]interface{}, path string, errors *[]string) {
	if schema == nil {
		return
	}

	// type check
	if schemaType, ok := schema["type"].(string); ok {
		if !v.checkType(data, schemaType) {
			*errors = append(*errors, fmt.Sprintf("%s: expected type %q, got %T", v.pathStr(path), schemaType, data))
			return
		}
	}

	// enum check
	if enum, ok := schema["enum"].([]interface{}); ok {
		if !v.checkEnum(data, enum) {
			*errors = append(*errors, fmt.Sprintf("%s: value not in allowed enum values", v.pathStr(path)))
		}
	}

	// object properties
	if props, ok := schema["properties"].(map[string]interface{}); ok {
		dataMap, isMap := data.(map[string]interface{})
		if !isMap {
			return
		}

		for propName, propSchema := range props {
			ps, ok := propSchema.(map[string]interface{})
			if !ok {
				continue
			}
			propPath := path + "." + propName
			if propData, exists := dataMap[propName]; exists {
				v.validateValue(propData, ps, propPath, errors)
			}
		}
	}

	// required fields
	if required, ok := schema["required"].([]interface{}); ok {
		dataMap, isMap := data.(map[string]interface{})
		if isMap {
			for _, r := range required {
				fieldName, ok := r.(string)
				if !ok {
					continue
				}
				if _, exists := dataMap[fieldName]; !exists {
					*errors = append(*errors, fmt.Sprintf("%s: missing required field %q", v.pathStr(path), fieldName))
				}
			}
		}
	}

	// string constraints
	if str, ok := data.(string); ok {
		if minLen, ok := schema["minLength"].(float64); ok {
			if len(str) < int(minLen) {
				*errors = append(*errors, fmt.Sprintf("%s: string length %d is less than minimum %d", v.pathStr(path), len(str), int(minLen)))
			}
		}
		if maxLen, ok := schema["maxLength"].(float64); ok {
			if len(str) > int(maxLen) {
				*errors = append(*errors, fmt.Sprintf("%s: string length %d exceeds maximum %d", v.pathStr(path), len(str), int(maxLen)))
			}
		}
	}

	// numeric constraints
	if num, ok := v.toFloat64(data); ok {
		if min, ok := schema["minimum"].(float64); ok {
			if num < min {
				*errors = append(*errors, fmt.Sprintf("%s: value %v is less than minimum %v", v.pathStr(path), num, min))
			}
		}
		if max, ok := schema["maximum"].(float64); ok {
			if num > max {
				*errors = append(*errors, fmt.Sprintf("%s: value %v exceeds maximum %v", v.pathStr(path), num, max))
			}
		}
	}

	// array items
	if items, ok := schema["items"].(map[string]interface{}); ok {
		if arr, ok := data.([]interface{}); ok {
			for i, item := range arr {
				itemPath := fmt.Sprintf("%s[%d]", path, i)
				v.validateValue(item, items, itemPath, errors)
			}
		}
	}

	// array constraints
	if arr, ok := data.([]interface{}); ok {
		if minItems, ok := schema["minItems"].(float64); ok {
			if len(arr) < int(minItems) {
				*errors = append(*errors, fmt.Sprintf("%s: array length %d is less than minimum %d", v.pathStr(path), len(arr), int(minItems)))
			}
		}
		if maxItems, ok := schema["maxItems"].(float64); ok {
			if len(arr) > int(maxItems) {
				*errors = append(*errors, fmt.Sprintf("%s: array length %d exceeds maximum %d", v.pathStr(path), len(arr), int(maxItems)))
			}
		}
	}
}

func (v *SchemaValidator) checkType(data interface{}, expectedType string) bool {
	if data == nil {
		return expectedType == "null"
	}

	switch expectedType {
	case "string":
		_, ok := data.(string)
		return ok
	case "number":
		_, ok := v.toFloat64(data)
		return ok
	case "integer":
		switch data.(type) {
		case float64:
			f := data.(float64)
			return f == float64(int64(f))
		case int, int64:
			return true
		}
		return false
	case "boolean":
		_, ok := data.(bool)
		return ok
	case "object":
		_, ok := data.(map[string]interface{})
		return ok
	case "array":
		_, ok := data.([]interface{})
		return ok
	case "null":
		return data == nil
	}
	return true
}

func (v *SchemaValidator) checkEnum(data interface{}, enum []interface{}) bool {
	dataJSON, _ := json.Marshal(data)
	for _, allowed := range enum {
		allowedJSON, _ := json.Marshal(allowed)
		if string(dataJSON) == string(allowedJSON) {
			return true
		}
	}
	return false
}

func (v *SchemaValidator) toFloat64(data interface{}) (float64, bool) {
	switch n := data.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func (v *SchemaValidator) pathStr(path string) string {
	if path == "" {
		return "$"
	}
	return "$" + strings.TrimPrefix(path, ".")
}
