defmodule Blok.Blob do
  @moduledoc "Bounded, capability-gated claim-check reads for `blob-v1`."

  @capability "blob-v1"
  @id ~r/^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/

  def capability, do: @capability

  def enabled? do
    case System.get_env("BLOK_BLOB_DIR") do
      nil -> false
      dir -> File.dir?(dir) and File.exists?(dir)
    end
  end

  def resolve(%{"$blokBlob" => %{"id" => id}} = value) when map_size(value) == 1 do
    root = System.get_env("BLOK_BLOB_DIR")
    max_bytes = env_integer("BLOK_BLOB_MAX_BYTES", 256 * 1024 * 1024)

    with true <- is_binary(root) and is_binary(id),
         true <- Regex.match?(@id, id),
         path = Path.join(root, id),
         {:ok, stat} <- File.stat(path),
         true <- stat.size <= max_bytes,
         {:ok, raw} <- File.read(path),
         {:ok, decoded} <- Jason.decode(raw) do
      {:ok, decoded}
    else
      false -> {:error, "invalid claim-check reference"}
      {:error, reason} -> {:error, "claim-check read failed: #{inspect(reason)}"}
      _ -> {:error, "claim-check exceeds BLOK_BLOB_MAX_BYTES"}
    end
  end

  def resolve(value), do: {:ok, value}

  defp env_integer(name, default) do
    case Integer.parse(System.get_env(name, "")) do
      {value, ""} when value > 0 -> value
      _ -> default
    end
  end
end
