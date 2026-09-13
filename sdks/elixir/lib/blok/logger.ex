defmodule Blok.Logger do
  @moduledoc "Structured, bounded logging with conservative secret redaction."

  require Logger

  def info(context, message, metadata \\ []), do: log(:info, context, message, metadata)
  def warning(context, message, metadata \\ []), do: log(:warning, context, message, metadata)
  def error(context, message, metadata \\ []), do: log(:error, context, message, metadata)

  @doc """
  Bounded `inspect/2` for untrusted terms.

  Crash reasons and exit payloads can carry an entire node input. Structured
  errors and telemetry metadata quote this instead of the raw term so a failure
  never turns into a payload leak.
  """
  @spec safe_inspect(term()) :: String.t()
  def safe_inspect(term),
    do: inspect(term, limit: 20, printable_limit: 256, structs: false) |> truncate()

  defp truncate(value) when byte_size(value) > 512,
    do: binary_part(value, 0, 512) <> "... [TRUNCATED]"

  defp truncate(value), do: value

  defp log(level, context, message, metadata) do
    safe = metadata |> Enum.into(%{}) |> redact()

    Logger.log(
      level,
      message,
      context |> Map.get(:logger_metadata, %{}) |> Map.merge(safe) |> Map.to_list()
    )
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
