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
