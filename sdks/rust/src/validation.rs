use serde_json::Value;

/// SchemaValidator validates data against a JSON Schema (Draft 7 subset).
pub struct SchemaValidator;

impl SchemaValidator {
    pub fn new() -> Self {
        Self
    }

    /// Validate data against a JSON Schema. Returns a list of error messages.
    pub fn validate(&self, data: &Value, schema: &Value) -> Vec<String> {
        let mut errors = Vec::new();
        self.validate_value(data, schema, "$", &mut errors);
        errors
    }

    fn validate_value(&self, data: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
        let schema_obj = match schema.as_object() {
            Some(obj) => obj,
            None => return,
        };

        // Type check
        if let Some(type_val) = schema_obj.get("type").and_then(|v| v.as_str()) {
            if !self.check_type(data, type_val) {
                errors.push(format!("{}: expected type \"{}\", got {}", path, type_val, self.type_name(data)));
                return;
            }
        }

        // Enum check
        if let Some(enum_vals) = schema_obj.get("enum").and_then(|v| v.as_array()) {
            if !enum_vals.contains(data) {
                errors.push(format!("{}: value not in allowed enum values", path));
            }
        }

        // Object: required fields
        if let (Some(required), Some(data_obj)) = (
            schema_obj.get("required").and_then(|v| v.as_array()),
            data.as_object(),
        ) {
            for field in required {
                if let Some(field_name) = field.as_str() {
                    if !data_obj.contains_key(field_name) {
                        errors.push(format!("{}: missing required field \"{}\"", path, field_name));
                    }
                }
            }
        }

        // Object: properties
        if let (Some(properties), Some(data_obj)) = (
            schema_obj.get("properties").and_then(|v| v.as_object()),
            data.as_object(),
        ) {
            for (prop_name, prop_schema) in properties {
                if let Some(prop_data) = data_obj.get(prop_name) {
                    let prop_path = format!("{}.{}", path, prop_name);
                    self.validate_value(prop_data, prop_schema, &prop_path, errors);
                }
            }
        }

        // String constraints
        if let Some(s) = data.as_str() {
            if let Some(min) = schema_obj.get("minLength").and_then(|v| v.as_u64()) {
                if (s.len() as u64) < min {
                    errors.push(format!("{}: string length {} is less than minimum {}", path, s.len(), min));
                }
            }
            if let Some(max) = schema_obj.get("maxLength").and_then(|v| v.as_u64()) {
                if (s.len() as u64) > max {
                    errors.push(format!("{}: string length {} exceeds maximum {}", path, s.len(), max));
                }
            }
        }

        // Numeric constraints
        if let Some(n) = data.as_f64() {
            if let Some(min) = schema_obj.get("minimum").and_then(|v| v.as_f64()) {
                if n < min {
                    errors.push(format!("{}: value {} is less than minimum {}", path, n, min));
                }
            }
            if let Some(max) = schema_obj.get("maximum").and_then(|v| v.as_f64()) {
                if n > max {
                    errors.push(format!("{}: value {} exceeds maximum {}", path, n, max));
                }
            }
        }

        // Array items
        if let (Some(items_schema), Some(arr)) = (schema_obj.get("items"), data.as_array()) {
            for (i, item) in arr.iter().enumerate() {
                let item_path = format!("{}[{}]", path, i);
                self.validate_value(item, items_schema, &item_path, errors);
            }
        }

        // Array constraints
        if let Some(arr) = data.as_array() {
            if let Some(min) = schema_obj.get("minItems").and_then(|v| v.as_u64()) {
                if (arr.len() as u64) < min {
                    errors.push(format!("{}: array length {} is less than minimum {}", path, arr.len(), min));
                }
            }
            if let Some(max) = schema_obj.get("maxItems").and_then(|v| v.as_u64()) {
                if (arr.len() as u64) > max {
                    errors.push(format!("{}: array length {} exceeds maximum {}", path, arr.len(), max));
                }
            }
        }
    }

    fn check_type(&self, data: &Value, expected: &str) -> bool {
        match expected {
            "string" => data.is_string(),
            "number" => data.is_number(),
            "integer" => data.is_i64() || data.is_u64() || (data.is_f64() && data.as_f64().map_or(false, |f| f.fract() == 0.0)),
            "boolean" => data.is_boolean(),
            "object" => data.is_object(),
            "array" => data.is_array(),
            "null" => data.is_null(),
            _ => true,
        }
    }

    fn type_name(&self, data: &Value) -> &'static str {
        match data {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
}

impl Default for SchemaValidator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_type_validation() {
        let v = SchemaValidator::new();

        assert!(v.validate(&serde_json::json!("hello"), &serde_json::json!({"type": "string"})).is_empty());
        assert!(!v.validate(&serde_json::json!(42), &serde_json::json!({"type": "string"})).is_empty());

        assert!(v.validate(&serde_json::json!(42), &serde_json::json!({"type": "number"})).is_empty());
        assert!(v.validate(&serde_json::json!(true), &serde_json::json!({"type": "boolean"})).is_empty());
        assert!(v.validate(&serde_json::json!({}), &serde_json::json!({"type": "object"})).is_empty());
        assert!(v.validate(&serde_json::json!([]), &serde_json::json!({"type": "array"})).is_empty());
        assert!(v.validate(&serde_json::json!(null), &serde_json::json!({"type": "null"})).is_empty());
    }

    #[test]
    fn test_required_fields() {
        let v = SchemaValidator::new();
        let schema = serde_json::json!({
            "type": "object",
            "required": ["name", "email"]
        });

        let valid = serde_json::json!({"name": "John", "email": "john@example.com"});
        assert!(v.validate(&valid, &schema).is_empty());

        let invalid = serde_json::json!({"name": "John"});
        assert_eq!(v.validate(&invalid, &schema).len(), 1);
    }

    #[test]
    fn test_string_constraints() {
        let v = SchemaValidator::new();
        let schema = serde_json::json!({"type": "string", "minLength": 2, "maxLength": 10});

        assert!(v.validate(&serde_json::json!("hello"), &schema).is_empty());
        assert!(!v.validate(&serde_json::json!("x"), &schema).is_empty());
        assert!(!v.validate(&serde_json::json!("this is way too long"), &schema).is_empty());
    }

    #[test]
    fn test_numeric_constraints() {
        let v = SchemaValidator::new();
        let schema = serde_json::json!({"type": "number", "minimum": 0, "maximum": 100});

        assert!(v.validate(&serde_json::json!(50), &schema).is_empty());
        assert!(!v.validate(&serde_json::json!(-1), &schema).is_empty());
        assert!(!v.validate(&serde_json::json!(101), &schema).is_empty());
    }

    #[test]
    fn test_enum_validation() {
        let v = SchemaValidator::new();
        let schema = serde_json::json!({"type": "string", "enum": ["red", "green", "blue"]});

        assert!(v.validate(&serde_json::json!("red"), &schema).is_empty());
        assert!(!v.validate(&serde_json::json!("yellow"), &schema).is_empty());
    }

    #[test]
    fn test_nested_object() {
        let v = SchemaValidator::new();
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "user": {
                    "type": "object",
                    "required": ["name"],
                    "properties": {
                        "name": {"type": "string"}
                    }
                }
            }
        });

        let valid = serde_json::json!({"user": {"name": "John"}});
        assert!(v.validate(&valid, &schema).is_empty());

        let invalid = serde_json::json!({"user": {}});
        assert_eq!(v.validate(&invalid, &schema).len(), 1);
    }
}
