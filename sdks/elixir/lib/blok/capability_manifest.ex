defmodule Blok.CapabilityManifest do
  @moduledoc "Validates the node capability boundary without atomizing wire data."

  @allowed_keys ~w(version classification effects capabilities secret_refs determinism idempotency maturity resources runtime_constraints)a

  def validate!(manifest) when is_map(manifest) do
    Enum.each(Map.keys(manifest), fn key ->
      unless is_binary(key) or key in @allowed_keys do
        raise ArgumentError, "capability manifest keys must be strings or declared atoms"
      end
    end)

    secret_refs = Map.get(manifest, "secret_refs", Map.get(manifest, :secret_refs, []))

    unless is_list(secret_refs) and Enum.all?(secret_refs, &(is_binary(&1) and &1 != "")) do
      raise ArgumentError, "capability manifest secret_refs must contain opaque reference names"
    end

    manifest
    |> Blok.Schema.to_json()
    |> Map.put_new("version", "1")
  end

  def validate!(_), do: raise(ArgumentError, "capability manifest must be a map")
end
