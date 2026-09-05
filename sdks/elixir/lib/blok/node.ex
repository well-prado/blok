defmodule Blok.Node do
  @moduledoc """
  Native Elixir node contract. Nodes are modules implementing this behaviour;
  protobuf and gRPC details stay inside the sidecar.
  """

  @callback execute(Blok.Context.t(), struct()) :: {:ok, term()} | {:error, term()}

  defmacro __using__(opts) do
    name = Keyword.fetch!(opts, :name)
    description = Keyword.get(opts, :description, "")
    input = Keyword.fetch!(opts, :input)
    output = Keyword.get(opts, :output)
    capability_manifest = Keyword.get(opts, :capability_manifest)

    quote bind_quoted: [
            name: name,
            description: description,
            input: input,
            output: output,
            capability_manifest: capability_manifest
          ] do
      @behaviour Blok.Node
      @blok_node_name name
      @blok_node_description description
      @blok_node_input input
      @blok_node_output output
      @blok_node_capability_manifest capability_manifest

      @doc false
      def __blok_node__ do
        %{
          name: @blok_node_name,
          description: @blok_node_description,
          input: @blok_node_input,
          output: @blok_node_output,
          capability_manifest: @blok_node_capability_manifest
        }
      end
    end
  end

  @doc false
  def descriptor(module) do
    metadata = module.__blok_node__()

    %{
      name: metadata.name,
      description: metadata.description,
      input_schema_json: Jason.encode!(metadata.input.__schema__()),
      output_schema_json: output_schema(metadata.output),
      capability_manifest_json: capability_manifest(metadata.capability_manifest),
      tags: []
    }
  end

  @doc false
  def run(module, context, raw_input) do
    metadata = module.__blok_node__()

    with {:ok, input} <- metadata.input.cast(raw_input),
         {:ok, result} <- normalize_result(module.execute(context, input)),
         {:ok, output} <- cast_output(metadata.output, result) do
      {:ok, output}
    else
      {:error, error} -> {:error, error}
    end
  rescue
    error -> {:error, error}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  defp normalize_result({:ok, value}), do: {:ok, value}
  defp normalize_result({:error, value}), do: {:error, value}
  defp normalize_result(value), do: {:ok, value}

  defp cast_output(nil, value), do: {:ok, value}
  defp cast_output(module, value), do: module.cast(Blok.Schema.to_json(value))

  defp output_schema(nil), do: ""
  defp output_schema(module), do: Jason.encode!(module.__schema__())

  defp capability_manifest(nil), do: ""

  defp capability_manifest(value),
    do: value |> Blok.CapabilityManifest.validate!() |> Jason.encode!()
end
