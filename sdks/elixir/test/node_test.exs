defmodule Blok.NodeTest do
  use ExUnit.Case, async: true

  defmodule Output do
    use Blok.Schema
    field :message, :string, required: true
  end

  defmodule TypedGreet do
    use Blok.Node,
      name: "typed-greet",
      description: "Returns a greeting",
      input: Blok.SchemaTest.Input,
      output: Output,
      capability_manifest: %{
        "version" => "1",
        "classification" => "agent-compatible",
        "secret_refs" => []
      }

    @impl Blok.Node
    def execute(_context, input), do: {:ok, %Output{message: "Hello, #{input.name}!"}}
  end

  test "executes typed input/output and reflects capabilities" do
    assert {:ok, %Output{message: "Hello, Ada!"}} =
             Blok.Node.run(TypedGreet, %{}, %{"name" => "Ada"})

    descriptor = Blok.Node.descriptor(TypedGreet)
    assert descriptor.name == "typed-greet"

    assert Jason.decode!(descriptor.capability_manifest_json)["classification"] ==
             "agent-compatible"
  end

  test "turns output validation failures into structured errors" do
    defmodule BadNode do
      use Blok.Node, name: "bad", input: Blok.SchemaTest.Input, output: Output
      def execute(_context, _input), do: {:ok, %{message: 123}}
    end

    assert {:error, %Blok.Schema.ValidationError{}} =
             Blok.Node.run(BadNode, %{}, %{"name" => "Ada"})
  end
end
