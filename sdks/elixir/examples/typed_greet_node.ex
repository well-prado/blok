defmodule Blok.Examples.TypedGreetInput do
  use Blok.Schema
  field :name, :string, required: true
end

defmodule Blok.Examples.TypedGreetOutput do
  use Blok.Schema
  field :message, :string, required: true
end

defmodule Blok.Examples.TypedGreet do
  use Blok.Node,
    name: "typed-greet",
    description: "Returns a greeting from the supervised BEAM runtime",
    input: Blok.Examples.TypedGreetInput,
    output: Blok.Examples.TypedGreetOutput,
    capability_manifest: %{"version" => "1", "classification" => "agent-compatible", "secret_refs" => []}

  @impl Blok.Node
  def execute(_ctx, input), do: {:ok, %Blok.Examples.TypedGreetOutput{message: "Hello, #{input.name}!"}}
end
