package com.blok.blok.validation;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for SchemaValidator.
 */
class SchemaValidatorTest {

    private SchemaValidator validator;

    @BeforeEach
    void setUp() {
        validator = new SchemaValidator();
    }

    @Test
    void validatesStringType() {
        Map<String, Object> schema = Map.of("type", "string");

        assertTrue(validator.validate("hello", schema).isEmpty());
        assertFalse(validator.validate(42, schema).isEmpty());
        assertFalse(validator.validate(true, schema).isEmpty());
    }

    @Test
    void validatesNumberType() {
        Map<String, Object> schema = Map.of("type", "number");

        assertTrue(validator.validate(42, schema).isEmpty());
        assertTrue(validator.validate(3.14, schema).isEmpty());
        assertFalse(validator.validate("hello", schema).isEmpty());
    }

    @Test
    void validatesIntegerType() {
        Map<String, Object> schema = Map.of("type", "integer");

        assertTrue(validator.validate(42, schema).isEmpty());
        assertTrue(validator.validate(42.0, schema).isEmpty());
        assertFalse(validator.validate(3.14, schema).isEmpty());
        assertFalse(validator.validate("hello", schema).isEmpty());
    }

    @Test
    void validatesBooleanType() {
        Map<String, Object> schema = Map.of("type", "boolean");

        assertTrue(validator.validate(true, schema).isEmpty());
        assertTrue(validator.validate(false, schema).isEmpty());
        assertFalse(validator.validate("true", schema).isEmpty());
    }

    @Test
    void validatesObjectType() {
        Map<String, Object> schema = Map.of("type", "object");

        assertTrue(validator.validate(Map.of("key", "value"), schema).isEmpty());
        assertFalse(validator.validate("string", schema).isEmpty());
    }

    @Test
    void validatesArrayType() {
        Map<String, Object> schema = Map.of("type", "array");

        assertTrue(validator.validate(List.of(1, 2, 3), schema).isEmpty());
        assertFalse(validator.validate("string", schema).isEmpty());
    }

    @Test
    void validatesRequiredFields() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        schema.put("required", List.of("name", "age"));

        Map<String, Object> valid = Map.of("name", "John", "age", 30);
        assertTrue(validator.validate(valid, schema).isEmpty());

        Map<String, Object> missing = Map.of("name", "John");
        List<String> errors = validator.validate(missing, schema);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("age"));
    }

    @Test
    void validatesProperties() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        schema.put("properties", Map.of(
                "name", Map.of("type", "string"),
                "age", Map.of("type", "number")
        ));

        Map<String, Object> valid = new HashMap<>();
        valid.put("name", "John");
        valid.put("age", 30);
        assertTrue(validator.validate(valid, schema).isEmpty());

        Map<String, Object> invalid = new HashMap<>();
        invalid.put("name", 123);
        invalid.put("age", "thirty");
        List<String> errors = validator.validate(invalid, schema);
        assertEquals(2, errors.size());
    }

    @Test
    void validatesEnum() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("enum", List.of("red", "green", "blue"));

        assertTrue(validator.validate("red", schema).isEmpty());
        assertTrue(validator.validate("blue", schema).isEmpty());

        List<String> errors = validator.validate("yellow", schema);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("enum"));
    }

    @Test
    void validatesMinLength() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "string");
        schema.put("minLength", 3);

        assertTrue(validator.validate("hello", schema).isEmpty());
        assertTrue(validator.validate("abc", schema).isEmpty());

        List<String> errors = validator.validate("ab", schema);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("less than minimum"));
    }

    @Test
    void validatesMaxLength() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "string");
        schema.put("maxLength", 5);

        assertTrue(validator.validate("hello", schema).isEmpty());
        assertTrue(validator.validate("hi", schema).isEmpty());

        List<String> errors = validator.validate("toolong", schema);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("exceeds maximum"));
    }

    @Test
    void validatesMinimum() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "number");
        schema.put("minimum", 0);

        assertTrue(validator.validate(5, schema).isEmpty());
        assertTrue(validator.validate(0, schema).isEmpty());

        List<String> errors = validator.validate(-1, schema);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("less than minimum"));
    }

    @Test
    void validatesMaximum() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "number");
        schema.put("maximum", 100);

        assertTrue(validator.validate(50, schema).isEmpty());
        assertTrue(validator.validate(100, schema).isEmpty());

        List<String> errors = validator.validate(101, schema);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).contains("exceeds maximum"));
    }

    @Test
    void validatesNestedProperties() {
        Map<String, Object> addressSchema = new HashMap<>();
        addressSchema.put("type", "object");
        addressSchema.put("properties", Map.of(
                "street", Map.of("type", "string"),
                "zip", Map.of("type", "string")
        ));

        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        schema.put("properties", Map.of("address", addressSchema));

        Map<String, Object> validAddress = new HashMap<>();
        validAddress.put("street", "123 Main St");
        validAddress.put("zip", "12345");

        Map<String, Object> valid = new HashMap<>();
        valid.put("address", validAddress);
        assertTrue(validator.validate(valid, schema).isEmpty());

        Map<String, Object> invalidAddress = new HashMap<>();
        invalidAddress.put("street", 123);

        Map<String, Object> invalid = new HashMap<>();
        invalid.put("address", invalidAddress);
        List<String> errors = validator.validate(invalid, schema);
        assertEquals(1, errors.size());
    }

    @Test
    void nullSchemaReturnsNoErrors() {
        assertTrue(validator.validate("anything", null).isEmpty());
    }

    @Test
    void nullDataValidatesAsNullType() {
        Map<String, Object> schema = Map.of("type", "null");
        assertTrue(validator.validate(null, schema).isEmpty());

        Map<String, Object> stringSchema = Map.of("type", "string");
        assertFalse(validator.validate(null, stringSchema).isEmpty());
    }

    @Test
    void combinedConstraints() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        schema.put("required", List.of("name", "email"));
        schema.put("properties", Map.of(
                "name", Map.of("type", "string", "minLength", 1),
                "email", Map.of("type", "string")
        ));

        Map<String, Object> valid = new HashMap<>();
        valid.put("name", "John");
        valid.put("email", "john@example.com");
        assertTrue(validator.validate(valid, schema).isEmpty());

        // Missing required + wrong type
        Map<String, Object> invalid = new HashMap<>();
        invalid.put("name", "");
        // email is missing
        List<String> errors = validator.validate(invalid, schema);
        assertFalse(errors.isEmpty());
    }
}
