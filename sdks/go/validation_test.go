package nanoservice

import "testing"

func TestValidateType(t *testing.T) {
	v := NewSchemaValidator()

	tests := []struct {
		name     string
		data     interface{}
		schema   map[string]interface{}
		wantErrs int
	}{
		{"string valid", "hello", map[string]interface{}{"type": "string"}, 0},
		{"string invalid", 42.0, map[string]interface{}{"type": "string"}, 1},
		{"number valid", 3.14, map[string]interface{}{"type": "number"}, 0},
		{"number invalid", "nope", map[string]interface{}{"type": "number"}, 1},
		{"integer valid", 42.0, map[string]interface{}{"type": "integer"}, 0},
		{"integer invalid", 3.14, map[string]interface{}{"type": "integer"}, 1},
		{"boolean valid", true, map[string]interface{}{"type": "boolean"}, 0},
		{"boolean invalid", "true", map[string]interface{}{"type": "boolean"}, 1},
		{"object valid", map[string]interface{}{}, map[string]interface{}{"type": "object"}, 0},
		{"object invalid", "not object", map[string]interface{}{"type": "object"}, 1},
		{"array valid", []interface{}{1, 2, 3}, map[string]interface{}{"type": "array"}, 0},
		{"array invalid", "not array", map[string]interface{}{"type": "array"}, 1},
		{"null valid", nil, map[string]interface{}{"type": "null"}, 0},
		{"null invalid", "not null", map[string]interface{}{"type": "null"}, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errs := v.Validate(tt.data, tt.schema)
			if len(errs) != tt.wantErrs {
				t.Errorf("expected %d errors, got %d: %v", tt.wantErrs, len(errs), errs)
			}
		})
	}
}

func TestValidateRequired(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type":     "object",
		"required": []interface{}{"name", "email"},
	}

	// Missing both
	errs := v.Validate(map[string]interface{}{}, schema)
	if len(errs) != 2 {
		t.Errorf("expected 2 errors, got %d: %v", len(errs), errs)
	}

	// Has both
	errs = v.Validate(map[string]interface{}{
		"name":  "test",
		"email": "test@example.com",
	}, schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	// Has one
	errs = v.Validate(map[string]interface{}{
		"name": "test",
	}, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error, got %d: %v", len(errs), errs)
	}
}

func TestValidateProperties(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"name": map[string]interface{}{"type": "string"},
			"age":  map[string]interface{}{"type": "number"},
		},
	}

	// Valid
	errs := v.Validate(map[string]interface{}{
		"name": "John",
		"age":  30.0,
	}, schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	// Invalid type
	errs = v.Validate(map[string]interface{}{
		"name": 123.0,
		"age":  "thirty",
	}, schema)
	if len(errs) != 2 {
		t.Errorf("expected 2 errors, got %d: %v", len(errs), errs)
	}
}

func TestValidateEnum(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type": "string",
		"enum": []interface{}{"red", "green", "blue"},
	}

	errs := v.Validate("red", schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	errs = v.Validate("yellow", schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error, got %d: %v", len(errs), errs)
	}
}

func TestValidateStringConstraints(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type":      "string",
		"minLength": 2.0,
		"maxLength": 10.0,
	}

	errs := v.Validate("hello", schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	errs = v.Validate("x", schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for too short, got %d: %v", len(errs), errs)
	}

	errs = v.Validate("this is way too long", schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for too long, got %d: %v", len(errs), errs)
	}
}

func TestValidateNumericConstraints(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type":    "number",
		"minimum": 0.0,
		"maximum": 100.0,
	}

	errs := v.Validate(50.0, schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	errs = v.Validate(-1.0, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for below minimum, got %d: %v", len(errs), errs)
	}

	errs = v.Validate(101.0, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for above maximum, got %d: %v", len(errs), errs)
	}
}

func TestValidateArrayItems(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type": "array",
		"items": map[string]interface{}{
			"type": "string",
		},
	}

	errs := v.Validate([]interface{}{"a", "b", "c"}, schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	errs = v.Validate([]interface{}{"a", 42.0, "c"}, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for non-string item, got %d: %v", len(errs), errs)
	}
}

func TestValidateArrayConstraints(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type":     "array",
		"minItems": 2.0,
		"maxItems": 4.0,
	}

	errs := v.Validate([]interface{}{1, 2, 3}, schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	errs = v.Validate([]interface{}{1}, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for too few items, got %d: %v", len(errs), errs)
	}

	errs = v.Validate([]interface{}{1, 2, 3, 4, 5}, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for too many items, got %d: %v", len(errs), errs)
	}
}

func TestValidateNestedObject(t *testing.T) {
	v := NewSchemaValidator()

	schema := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"user": map[string]interface{}{
				"type":     "object",
				"required": []interface{}{"name"},
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string"},
					"age":  map[string]interface{}{"type": "number"},
				},
			},
		},
	}

	// Valid
	errs := v.Validate(map[string]interface{}{
		"user": map[string]interface{}{
			"name": "John",
			"age":  30.0,
		},
	}, schema)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(errs), errs)
	}

	// Missing required nested field
	errs = v.Validate(map[string]interface{}{
		"user": map[string]interface{}{
			"age": 30.0,
		},
	}, schema)
	if len(errs) != 1 {
		t.Errorf("expected 1 error for missing name, got %d: %v", len(errs), errs)
	}
}

func TestValidateNilSchema(t *testing.T) {
	v := NewSchemaValidator()
	errs := v.Validate("anything", nil)
	if len(errs) != 0 {
		t.Errorf("expected 0 errors for nil schema, got %d", len(errs))
	}
}
