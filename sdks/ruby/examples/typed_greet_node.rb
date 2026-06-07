# frozen_string_literal: true

require_relative "../lib/blok"

# Typed greeting node demonstrating the SPEC-B TypedNode contract.
class TypedGreetNode < Blok::Node::TypedNode
  node_name "typed-greet"
  description "Typed greeting (SPEC-B contract demo)"

  input do
    field :name, :string, required: true
    field :repeat, :integer, default: 1
  end

  output do
    field :greeting, :string
    field :length, :integer
  end

  def run(_ctx, input)
    repeat = input[:repeat].is_a?(Integer) && input[:repeat].positive? ? input[:repeat] : 1
    greeting = ("Hello, " + input[:name]) * repeat
    { "greeting" => greeting, "length" => greeting.length }
  end
end
