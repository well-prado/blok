defmodule Blok.Logger do
  @moduledoc "Structured, bounded logging with conservative secret redaction."

  require Logger

  def info(context, message, metadata \\ []), do: log(:info, context, message, metadata)
  def warning(context, message, metadata \\ []), do: log(:warning, context, message, metadata)
  def error(context, message, metadata \\ []), do: log(:error, context, message, metadata)

  defp log(level, context, message, metadata) do
    safe = metadata |> Enum.into(%{}) |> redact()
    Logger.log(level, message, metadata: Map.merge(Map.get(context, :logger_metadata, %{}), safe))
  end

  defp redact(value) when is_map(value),
    do:
      Map.new(value, fn {key, item} ->
        {key, if(secret_key?(key), do: "[REDACTED]", else: redact(item))}
      end)

  defp redact(value) when is_list(value), do: Enum.map(value, &redact/1)
  defp redact(value) when is_binary(value) and byte_size(value) > 2048, do: "[TRUNCATED]"
  defp redact(value), do: value

  defp secret_key?(key),
    do:
      key
      |> to_string()
      |> String.downcase()
      |> then(
        &String.contains?(&1, ["secret", "token", "password", "credential", "authorization"])
      )
end
