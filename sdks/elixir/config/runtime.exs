import Config

parse_integer = fn name, default ->
  case System.get_env(name) do
    nil ->
      default

    value ->
      case Integer.parse(value) do
        {parsed, ""} when parsed > 0 -> parsed
        _ -> default
      end
  end
end

config :blok,
  host: System.get_env("HOST", "0.0.0.0"),
  port: parse_integer.("GRPC_PORT", parse_integer.("RUNTIME_ELIXIR_GRPC_PORT", 10010)),
  max_message_bytes: parse_integer.("BLOK_GRPC_MAX_MESSAGE_BYTES", 16 * 1024 * 1024),
  max_concurrency: parse_integer.("BLOK_ELIXIR_MAX_CONCURRENCY", 16),
  max_queue: parse_integer.("BLOK_ELIXIR_MAX_QUEUE", 64),
  cancellation_grace_ms: parse_integer.("BLOK_ELIXIR_CANCELLATION_GRACE_MS", 250)
