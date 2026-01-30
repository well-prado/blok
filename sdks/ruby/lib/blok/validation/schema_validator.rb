# frozen_string_literal: true

module Blok
  module Validation
    # SchemaValidator validates data against a JSON Schema (Draft 7 subset).
    # Supports type checking, required fields, nested properties, enum,
    # string length constraints, numeric range constraints, and array item validation.
    class SchemaValidator
      # Validate data against a schema.
      # @param data [Object] The data to validate (parsed JSON)
      # @param schema [Hash] The JSON Schema definition
      # @return [Array<String>] List of validation error messages (empty if valid)
      def validate(data, schema)
        errors = []
        validate_value(data, schema, "$", errors)
        errors
      end

      private

      def validate_value(data, schema, path, errors)
        return unless schema.is_a?(Hash)

        # Type check
        if schema.key?("type")
          expected_type = schema["type"]
          unless check_type(data, expected_type)
            errors << "#{path}: expected type \"#{expected_type}\", got #{type_name(data)}"
            return
          end
        end

        # Enum check
        if schema.key?("enum")
          enum_values = schema["enum"]
          if enum_values.is_a?(Array) && !enum_values.include?(data)
            errors << "#{path}: value not in allowed enum values"
          end
        end

        # Object: required fields
        if schema.key?("required") && data.is_a?(Hash)
          schema["required"].each do |field|
            unless data.key?(field)
              errors << "#{path}: missing required field \"#{field}\""
            end
          end
        end

        # Object: properties
        if schema.key?("properties") && data.is_a?(Hash)
          schema["properties"].each do |prop_name, prop_schema|
            if data.key?(prop_name)
              validate_value(data[prop_name], prop_schema, "#{path}.#{prop_name}", errors)
            end
          end
        end

        # String constraints
        if data.is_a?(String)
          if schema.key?("min_length") || schema.key?("minLength")
            min = schema["min_length"] || schema["minLength"]
            if data.length < min
              errors << "#{path}: string length #{data.length} is less than minimum #{min}"
            end
          end
          if schema.key?("max_length") || schema.key?("maxLength")
            max = schema["max_length"] || schema["maxLength"]
            if data.length > max
              errors << "#{path}: string length #{data.length} exceeds maximum #{max}"
            end
          end
        end

        # Numeric constraints
        if data.is_a?(Numeric)
          if schema.key?("minimum")
            min = schema["minimum"]
            if data < min
              errors << "#{path}: value #{data} is less than minimum #{min}"
            end
          end
          if schema.key?("maximum")
            max = schema["maximum"]
            if data > max
              errors << "#{path}: value #{data} exceeds maximum #{max}"
            end
          end
        end

        # Array items
        if schema.key?("items") && data.is_a?(Array)
          data.each_with_index do |item, i|
            validate_value(item, schema["items"], "#{path}[#{i}]", errors)
          end
        end

        # Array constraints
        if data.is_a?(Array)
          if schema.key?("min_items") || schema.key?("minItems")
            min = schema["min_items"] || schema["minItems"]
            if data.length < min
              errors << "#{path}: array length #{data.length} is less than minimum #{min}"
            end
          end
          if schema.key?("max_items") || schema.key?("maxItems")
            max = schema["max_items"] || schema["maxItems"]
            if data.length > max
              errors << "#{path}: array length #{data.length} exceeds maximum #{max}"
            end
          end
        end
      end

      def check_type(data, expected)
        case expected
        when "string"  then data.is_a?(String)
        when "number"  then data.is_a?(Numeric)
        when "integer" then data.is_a?(Integer)
        when "boolean" then data == true || data == false
        when "object"  then data.is_a?(Hash)
        when "array"   then data.is_a?(Array)
        when "null"    then data.nil?
        else true
        end
      end

      def type_name(data)
        case data
        when nil    then "null"
        when true, false then "boolean"
        when Integer then "integer"
        when Numeric then "number"
        when String  then "string"
        when Array   then "array"
        when Hash    then "object"
        else data.class.name
        end
      end
    end
  end
end
