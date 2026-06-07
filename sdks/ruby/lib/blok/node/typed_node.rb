# frozen_string_literal: true

require "json"
require_relative "node_handler"
require_relative "../errors/blok_error"

module Blok
  module Node
    # TypedNode is the typed authoring contract (SPEC-B P4) — the Ruby equivalent
    # of the TypeScript +defineNode+ / Python +@node+ / Rust +TypedNode+. Declare
    # an input schema with a small DSL; the SDK validates the raw config against
    # it (missing required field / wrong type -> structured BlokError, HTTP 400)
    # BEFORE +run+, passes a symbol-keyed, defaulted input hash, and reflects the
    # JSON Schema for the node catalog (GET /__blok/nodes) — instead of a raw
    # config Hash.
    #
    # @example
    #   class SearchNode < Blok::Node::TypedNode
    #     node_name "@acme/search"
    #     description "Full-text search"
    #     input do
    #       field :query, :string, required: true
    #       field :limit, :integer, default: 10
    #     end
    #
    #     def run(ctx, input)
    #       rows = [input[:query]] * input[:limit]
    #       { "results" => rows, "count" => rows.size }
    #     end
    #   end
    class TypedNode < NodeHandler
      # JSON Schema type name for each declared field type.
      JSON_TYPES = {
        string: "string", integer: "integer", number: "number",
        boolean: "boolean", array: "array", object: "object"
      }.freeze

      # Acceptable Ruby classes for each declared field type.
      RUBY_TYPES = {
        string: [String], integer: [Integer], number: [Integer, Float],
        boolean: [TrueClass, FalseClass], array: [Array], object: [Hash]
      }.freeze

      # One declared field in an input/output schema.
      Field = Struct.new(:name, :type, :required, :default, :has_default, keyword_init: true)

      # Collects +field+ declarations from an +input+/+output+ block.
      class SchemaBuilder
        attr_reader :fields

        def initialize
          @fields = []
        end

        # @param name [Symbol] field name
        # @param type [Symbol] one of :string, :integer, :number, :boolean, :array, :object
        # @param required [Boolean] whether the field must be present
        def field(name, type, required: false, **opts)
          @fields << Field.new(
            name: name.to_sym, type: type.to_sym, required: required,
            default: opts[:default], has_default: opts.key?(:default)
          )
        end
      end

      class << self
        # Get/set the registered node name (e.g. "@acme/search").
        def node_name(value = nil)
          @node_name = value unless value.nil?
          @node_name
        end

        # Get/set the human-readable description.
        def description(value = nil)
          @description = value unless value.nil?
          @description || ""
        end

        def input(&block)
          builder = SchemaBuilder.new
          builder.instance_eval(&block)
          @input_fields = builder.fields
        end

        def output(&block)
          builder = SchemaBuilder.new
          builder.instance_eval(&block)
          @output_fields = builder.fields
        end

        def input_fields
          @input_fields || []
        end

        def output_fields
          @output_fields
        end

        # Build a JSON Schema (Ruby Hash) from a list of fields.
        def schema_for(fields)
          properties = {}
          required = []
          fields.each do |f|
            properties[f.name.to_s] = { "type" => JSON_TYPES.fetch(f.type, "object") }
            required << f.name.to_s if f.required
          end
          schema = { "type" => "object", "properties" => properties }
          schema["required"] = required unless required.empty?
          schema
        end
      end

      # NodeHandler entry point: validate the raw config, then run.
      def execute(ctx, config)
        input = validate_input(config)
        run(ctx, input)
      end

      # Run the node with a VALIDATED, symbol-keyed input hash. Override this.
      def run(ctx, input)
        raise NotImplementedError, "#{self.class}#run must be implemented"
      end

      # ---- Reflection (consumed by the gRPC ListNodes catalog) ----

      # @return [Hash] { description:, input_schema_json:, output_schema_json: }
      def reflect
        out_fields = self.class.output_fields
        {
          description: self.class.description,
          input_schema_json: JSON.generate(self.class.schema_for(self.class.input_fields)),
          output_schema_json: out_fields.nil? ? nil : JSON.generate(self.class.schema_for(out_fields))
        }
      end

      private

      def validate_input(config)
        result = {}
        self.class.input_fields.each do |f|
          key = f.name.to_s
          if config.key?(key) || config.key?(f.name)
            value = config.key?(key) ? config[key] : config[f.name]
            check_type!(f, value)
            result[f.name] = value
          elsif f.has_default
            result[f.name] = f.default
          elsif f.required
            raise validation_error("missing required field '#{f.name}'")
          else
            result[f.name] = nil
          end
        end
        result
      end

      def check_type!(field, value)
        return if value.nil? && !field.required

        allowed = RUBY_TYPES[field.type]
        return if allowed.nil? # unknown type → don't enforce
        return if allowed.any? { |klass| value.is_a?(klass) }

        raise validation_error(
          "field '#{field.name}' expected #{field.type}, got #{value.class}"
        )
      end

      def validation_error(detail)
        name = self.class.node_name.to_s
        Blok::Errors::BlokError.validation(
          code: "NODE_INPUT_VALIDATION",
          message: "Input validation failed for node '#{name}': #{detail}",
          http_status: 400,
          node: name
        )
      end
    end
  end
end
