# frozen_string_literal: true

require_relative "../test_helper"

class SchemaValidatorTest < Minitest::Test
  def setup
    @v = Nanoservice::Validation::SchemaValidator.new
  end

  # ---- Type validation ----

  def test_string_type_valid
    assert_empty @v.validate("hello", { "type" => "string" })
  end

  def test_string_type_invalid
    refute_empty @v.validate(42, { "type" => "string" })
  end

  def test_number_type_valid
    assert_empty @v.validate(42, { "type" => "number" })
    assert_empty @v.validate(3.14, { "type" => "number" })
  end

  def test_number_type_invalid
    refute_empty @v.validate("not a number", { "type" => "number" })
  end

  def test_integer_type_valid
    assert_empty @v.validate(42, { "type" => "integer" })
  end

  def test_integer_type_invalid
    refute_empty @v.validate(3.14, { "type" => "integer" })
  end

  def test_boolean_type_valid
    assert_empty @v.validate(true, { "type" => "boolean" })
    assert_empty @v.validate(false, { "type" => "boolean" })
  end

  def test_boolean_type_invalid
    refute_empty @v.validate("true", { "type" => "boolean" })
  end

  def test_object_type_valid
    assert_empty @v.validate({}, { "type" => "object" })
  end

  def test_array_type_valid
    assert_empty @v.validate([], { "type" => "array" })
  end

  def test_null_type_valid
    assert_empty @v.validate(nil, { "type" => "null" })
  end

  # ---- Required fields ----

  def test_required_fields_present
    schema = { "type" => "object", "required" => %w[name email] }
    data   = { "name" => "John", "email" => "john@example.com" }
    assert_empty @v.validate(data, schema)
  end

  def test_required_fields_missing
    schema = { "type" => "object", "required" => %w[name email] }
    data   = { "name" => "John" }
    errors = @v.validate(data, schema)
    assert_equal 1, errors.length
    assert_match(/email/, errors[0])
  end

  def test_required_all_missing
    schema = { "type" => "object", "required" => %w[a b c] }
    errors = @v.validate({}, schema)
    assert_equal 3, errors.length
  end

  # ---- Nested properties ----

  def test_nested_object_valid
    schema = {
      "type" => "object",
      "properties" => {
        "user" => {
          "type" => "object",
          "required" => ["name"],
          "properties" => {
            "name" => { "type" => "string" }
          }
        }
      }
    }
    data = { "user" => { "name" => "John" } }
    assert_empty @v.validate(data, schema)
  end

  def test_nested_object_invalid
    schema = {
      "type" => "object",
      "properties" => {
        "user" => {
          "type" => "object",
          "required" => ["name"]
        }
      }
    }
    data = { "user" => {} }
    errors = @v.validate(data, schema)
    assert_equal 1, errors.length
    assert_match(/name/, errors[0])
  end

  def test_nested_type_mismatch
    schema = {
      "type" => "object",
      "properties" => {
        "age" => { "type" => "integer" }
      }
    }
    data   = { "age" => "not a number" }
    errors = @v.validate(data, schema)
    assert_equal 1, errors.length
  end

  # ---- Enum ----

  def test_enum_valid
    schema = { "type" => "string", "enum" => %w[red green blue] }
    assert_empty @v.validate("red", schema)
  end

  def test_enum_invalid
    schema = { "type" => "string", "enum" => %w[red green blue] }
    errors = @v.validate("yellow", schema)
    assert_equal 1, errors.length
    assert_match(/enum/, errors[0])
  end

  # ---- String constraints ----

  def test_min_length_valid
    schema = { "type" => "string", "minLength" => 2 }
    assert_empty @v.validate("hi", schema)
  end

  def test_min_length_invalid
    schema = { "type" => "string", "minLength" => 5 }
    refute_empty @v.validate("hi", schema)
  end

  def test_max_length_valid
    schema = { "type" => "string", "maxLength" => 10 }
    assert_empty @v.validate("hello", schema)
  end

  def test_max_length_invalid
    schema = { "type" => "string", "maxLength" => 3 }
    refute_empty @v.validate("hello", schema)
  end

  def test_min_length_snake_case_key
    schema = { "type" => "string", "min_length" => 3 }
    refute_empty @v.validate("hi", schema)
  end

  def test_max_length_snake_case_key
    schema = { "type" => "string", "max_length" => 3 }
    refute_empty @v.validate("hello", schema)
  end

  # ---- Numeric constraints ----

  def test_minimum_valid
    schema = { "type" => "number", "minimum" => 0 }
    assert_empty @v.validate(5, schema)
  end

  def test_minimum_invalid
    schema = { "type" => "number", "minimum" => 0 }
    refute_empty @v.validate(-1, schema)
  end

  def test_maximum_valid
    schema = { "type" => "number", "maximum" => 100 }
    assert_empty @v.validate(50, schema)
  end

  def test_maximum_invalid
    schema = { "type" => "number", "maximum" => 100 }
    refute_empty @v.validate(101, schema)
  end

  def test_min_and_max_combined
    schema = { "type" => "number", "minimum" => 0, "maximum" => 100 }
    assert_empty @v.validate(50, schema)
    refute_empty @v.validate(-1, schema)
    refute_empty @v.validate(101, schema)
  end

  # ---- Array items ----

  def test_array_items_valid
    schema = {
      "type" => "array",
      "items" => { "type" => "string" }
    }
    assert_empty @v.validate(%w[a b c], schema)
  end

  def test_array_items_invalid
    schema = {
      "type" => "array",
      "items" => { "type" => "string" }
    }
    errors = @v.validate(["a", 42, "c"], schema)
    assert_equal 1, errors.length
    assert_match(/\[1\]/, errors[0])
  end

  def test_min_items_valid
    schema = { "type" => "array", "minItems" => 2 }
    assert_empty @v.validate([1, 2, 3], schema)
  end

  def test_min_items_invalid
    schema = { "type" => "array", "minItems" => 3 }
    refute_empty @v.validate([1], schema)
  end

  def test_max_items_valid
    schema = { "type" => "array", "maxItems" => 3 }
    assert_empty @v.validate([1, 2], schema)
  end

  def test_max_items_invalid
    schema = { "type" => "array", "maxItems" => 2 }
    refute_empty @v.validate([1, 2, 3], schema)
  end

  def test_min_items_snake_case_key
    schema = { "type" => "array", "min_items" => 2 }
    refute_empty @v.validate([1], schema)
  end

  def test_max_items_snake_case_key
    schema = { "type" => "array", "max_items" => 1 }
    refute_empty @v.validate([1, 2], schema)
  end

  # ---- Edge cases ----

  def test_empty_schema_always_valid
    assert_empty @v.validate("anything", {})
    assert_empty @v.validate(42, {})
    assert_empty @v.validate(nil, {})
  end

  def test_type_mismatch_stops_further_validation
    schema = {
      "type" => "string",
      "minLength" => 5
    }
    errors = @v.validate(42, schema)
    # Should only report type mismatch, not minLength
    assert_equal 1, errors.length
    assert_match(/type/, errors[0])
  end
end
