# frozen_string_literal: true

require "minitest/autorun"
require "json"
# Require the pure-Ruby contract files directly (avoids loading the
# protobuf/grpc stack, so this runs without the gRPC gems installed).
require_relative "../../lib/blok/node/typed_node"

class TypedNodeTest < Minitest::Test
  class SearchNode < Blok::Node::TypedNode
    node_name "@acme/search"
    description "Full-text search"

    input do
      field :query, :string, required: true
      field :limit, :integer, default: 10
    end

    output do
      field :results, :array
      field :count, :integer
    end

    def run(_ctx, input)
      rows = [input[:query]] * input[:limit]
      { "results" => rows, "count" => rows.size }
    end
  end

  def test_validates_input_and_runs
    out = SearchNode.new.execute(nil, { "query" => "ada", "limit" => 2 })
    assert_equal 2, out["count"]
    assert_equal %w[ada ada], out["results"]
  end

  def test_applies_default_values
    out = SearchNode.new.execute(nil, { "query" => "x" })
    assert_equal 10, out["count"]
  end

  def test_missing_required_field_raises_structured_blok_error
    err = assert_raises(Blok::Errors::BlokError) do
      SearchNode.new.execute(nil, { "limit" => 3 })
    end
    assert_equal 400, err.http_status
    assert_equal "NODE_INPUT_VALIDATION", err.code
    assert_equal "@acme/search", err.node
  end

  def test_wrong_type_raises_structured_blok_error
    err = assert_raises(Blok::Errors::BlokError) do
      SearchNode.new.execute(nil, { "query" => 123 }) # Integer where :string declared
    end
    assert_equal 400, err.http_status
  end

  def test_reflection_schemas_and_description
    reflection = SearchNode.new.reflect
    assert_equal "Full-text search", reflection[:description]

    schema = JSON.parse(reflection[:input_schema_json])
    assert_equal "object", schema["type"]
    assert schema["properties"].key?("query")
    assert_equal ["query"], schema["required"]
    refute_nil reflection[:output_schema_json]
  end
end
