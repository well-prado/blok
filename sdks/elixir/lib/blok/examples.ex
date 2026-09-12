defmodule Blok.Examples.HelloWorldInput do
  use Blok.Schema

  field :prefix, :string, default: "Hello from the Elixir runtime"
end

defmodule Blok.Examples.HelloWorldOutput do
  use Blok.Schema

  field :message, :string, required: true
  field :timestamp, :string, required: true
  field :language, :string, required: true
end

defmodule Blok.Examples.HelloWorld do
  use Blok.Node,
    name: "hello-world",
    description: "Returns a canonical cross-runtime greeting",
    input: Blok.Examples.HelloWorldInput,
    output: Blok.Examples.HelloWorldOutput,
    capability_manifest: %{
      "version" => "1",
      "classification" => "agent-compatible",
      "secret_refs" => []
    }

  @impl Blok.Node
  def execute(ctx, input) do
    name = get_in(ctx.request, [:body, "name"]) || "World"

    {:ok,
     %Blok.Examples.HelloWorldOutput{
       message: "#{input.prefix}, #{name}!",
       timestamp: DateTime.utc_now() |> DateTime.to_iso8601(),
       language: "elixir"
     }}
  end
end

defmodule Blok.Examples.TypedGreetInput do
  use Blok.Schema
  field :name, :string, required: true
  field :repeat, :integer, default: 1
end

defmodule Blok.Examples.TypedGreetOutput do
  use Blok.Schema
  field :greeting, :string, required: true
  field :length, :integer, required: true
end

defmodule Blok.Examples.TypedGreet do
  use Blok.Node,
    name: "typed-greet",
    description: "Canonical typed greeting fixture",
    input: Blok.Examples.TypedGreetInput,
    output: Blok.Examples.TypedGreetOutput,
    capability_manifest: %{
      "version" => "1",
      "classification" => "agent-compatible",
      "effects" => [],
      "capabilities" => [],
      "secrets" => [],
      "determinism" => "deterministic",
      "idempotency" => "idempotent",
      "maturity" => "stable",
      "resources" => %{
        "maxDurationMs" => 5000,
        "maxInputBytes" => 4_194_304,
        "maxOutputBytes" => 4_194_304,
        "maxConcurrency" => 64
      }
    }

  @impl Blok.Node
  def execute(_ctx, input) do
    greeting = String.duplicate("Hello, " <> input.name, input.repeat)
    {:ok, %Blok.Examples.TypedGreetOutput{greeting: greeting, length: String.length(greeting)}}
  end
end

defmodule Blok.Examples.ChainInput do
  use Blok.Schema
  field :chain, :array, default: []
  field :origin, :string, required: true
end

defmodule Blok.Examples.ChainOutput do
  use Blok.Schema
  field :chain, :array, required: true
  field :origin, :string, required: true
end

defmodule Blok.Examples.ChainTest do
  use Blok.Node,
    name: "chain-test",
    description: "Canonical cross-runtime chain fixture",
    input: Blok.Examples.ChainInput,
    output: Blok.Examples.ChainOutput

  @impl Blok.Node
  def execute(_ctx, input) do
    entry = %{"language" => "elixir", "order" => length(input.chain) + 1}
    {:ok, %Blok.Examples.ChainOutput{chain: input.chain ++ [entry], origin: input.origin}}
  end
end
