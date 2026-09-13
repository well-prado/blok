defmodule Blok.Config do
  @moduledoc """
  Startup configuration for the sidecar, parsed and validated from the process
  environment.

  Every knob is an environment variable and every malformed value fails the
  boot with a message naming the variable. A sidecar that silently ignored a
  typo in `BLOK_GRPC_MAX_MESSAGE_BYTES` would look healthy while enforcing the
  wrong limit, so parsing is strict rather than best-effort.

  | Variable | Default | Meaning |
  | --- | --- | --- |
  | `HOST` | `0.0.0.0` | Bind address (IPv4/IPv6 literal). |
  | `GRPC_PORT` / `RUNTIME_ELIXIR_GRPC_PORT` | `10010` | Listen port. |
  | `BLOK_GRPC_MAX_MESSAGE_BYTES` | 16 MiB | Maximum accepted request body. |
  | `BLOK_GRPC_KEEPALIVE_TIME_MS` | `10000` | Connection idle ceiling. |
  | `BLOK_GRPC_KEEPALIVE_TIMEOUT_MS` | `5000` | HTTP/2 settings/handshake ceiling. |
  | `BLOK_GRPC_MAX_CONNECTIONS` | `256` | Accepted concurrent connections. |
  | `BLOK_GRPC_TLS_CERT` / `BLOK_GRPC_TLS_KEY` | unset | Server TLS pair (both or neither). |
  | `BLOK_GRPC_TLS_CA` | unset | Client CA — turns TLS into mTLS. |
  | `BLOK_ELIXIR_MAX_CONCURRENCY` | `16` | Concurrently executing nodes. |
  | `BLOK_ELIXIR_MAX_QUEUE` | `64` | Pending executions before `RUNTIME_OVERLOADED`. |
  | `BLOK_ELIXIR_CANCELLATION_GRACE_MS` | `250` | Drain grace before forced termination. |
  | `BLOK_LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error`, or `none`. |

  The BEAM sidecar does not send server-initiated HTTP/2 pings: the keepalive
  variables exist for parity with the other SDKs and are enforced as Cowboy
  idle/inactivity/settings ceilings instead.
  """

  defstruct host: "0.0.0.0",
            ip: {0, 0, 0, 0},
            port: 10010,
            max_message_bytes: 16 * 1024 * 1024,
            keepalive_time_ms: 10_000,
            keepalive_timeout_ms: 5_000,
            max_connections: 256,
            tls: nil,
            max_concurrency: 16,
            max_queue: 64,
            cancellation_grace_ms: 250,
            log_level: :info

  @type t :: %__MODULE__{}

  # An allow-list, not `String.to_atom/1`: BLOK_LOG_LEVEL is external input.
  @log_levels %{
    "debug" => :debug,
    "info" => :info,
    "warning" => :warning,
    "error" => :error,
    "none" => :none
  }

  @doc "Parse and validate configuration, raising `ArgumentError` on bad input."
  @spec load!(map()) :: t()
  def load!(env \\ System.get_env()) do
    host = Map.get(env, "HOST", "0.0.0.0")

    %__MODULE__{
      host: host,
      ip: ip!(host),
      port: port!(env),
      max_message_bytes: integer!(env, "BLOK_GRPC_MAX_MESSAGE_BYTES", 16 * 1024 * 1024),
      keepalive_time_ms: integer!(env, "BLOK_GRPC_KEEPALIVE_TIME_MS", 10_000),
      keepalive_timeout_ms: integer!(env, "BLOK_GRPC_KEEPALIVE_TIMEOUT_MS", 5_000),
      max_connections: integer!(env, "BLOK_GRPC_MAX_CONNECTIONS", 256),
      tls: tls!(env),
      max_concurrency: integer!(env, "BLOK_ELIXIR_MAX_CONCURRENCY", 16),
      max_queue: integer!(env, "BLOK_ELIXIR_MAX_QUEUE", 64),
      cancellation_grace_ms: integer!(env, "BLOK_ELIXIR_CANCELLATION_GRACE_MS", 250),
      log_level: log_level!(env)
    }
  end

  @doc "Child options for `GRPC.Server.Supervisor`."
  @spec server_opts(t()) :: keyword()
  def server_opts(%__MODULE__{} = config) do
    [
      endpoint: Blok.Endpoint,
      port: config.port,
      start_server: true,
      max_body_size: config.max_message_bytes,
      adapter_opts: adapter_opts(config)
    ]
  end

  @doc false
  def adapter_opts(%__MODULE__{} = config) do
    opts = [
      ip: config.ip,
      max_connections: config.max_connections,
      idle_timeout: config.keepalive_time_ms,
      inactivity_timeout: config.keepalive_time_ms + config.keepalive_timeout_ms,
      settings_timeout: config.keepalive_timeout_ms
    ]

    case config.tls do
      nil -> opts
      tls -> Keyword.put(opts, :cred, GRPC.Credential.new(ssl: ssl_opts(tls)))
    end
  end

  defp ssl_opts(%{cert: cert, key: key, ca: nil}), do: [certfile: cert, keyfile: key]

  defp ssl_opts(%{cert: cert, key: key, ca: ca}),
    do: [
      certfile: cert,
      keyfile: key,
      cacertfile: ca,
      verify: :verify_peer,
      fail_if_no_peer_cert: true
    ]

  defp port!(env) do
    value =
      integer!(env, "GRPC_PORT", nil) || integer!(env, "RUNTIME_ELIXIR_GRPC_PORT", nil) || 10_010

    if value > 65_535 do
      raise ArgumentError, "GRPC_PORT must be between 1 and 65535, got #{value}"
    end

    value
  end

  defp integer!(env, name, default) do
    case Map.get(env, name) do
      nil ->
        default

      "" ->
        default

      value ->
        case Integer.parse(value) do
          {parsed, ""} when parsed > 0 ->
            parsed

          _ ->
            raise ArgumentError, "#{name} must be a positive integer, got #{inspect(value)}"
        end
    end
  end

  defp log_level!(env) do
    case Map.get(env, "BLOK_LOG_LEVEL") do
      nil ->
        :info

      "" ->
        :info

      value ->
        Map.get(@log_levels, String.downcase(value)) ||
          raise ArgumentError,
                "BLOK_LOG_LEVEL must be one of #{Enum.join(Map.keys(@log_levels), ", ")}, got #{inspect(value)}"
    end
  end

  defp ip!("0.0.0.0"), do: {0, 0, 0, 0}
  defp ip!("::"), do: {0, 0, 0, 0, 0, 0, 0, 0}

  defp ip!(host) do
    case :inet.parse_address(String.to_charlist(host)) do
      {:ok, address} ->
        address

      _ ->
        raise ArgumentError, "HOST must be an IP address literal, got #{inspect(host)}"
    end
  end

  defp tls!(env) do
    cert = presence(env, "BLOK_GRPC_TLS_CERT")
    key = presence(env, "BLOK_GRPC_TLS_KEY")
    ca = presence(env, "BLOK_GRPC_TLS_CA")

    case {cert, key} do
      {nil, nil} ->
        nil

      {nil, _} ->
        raise ArgumentError, "BLOK_GRPC_TLS_KEY is set without BLOK_GRPC_TLS_CERT"

      {_, nil} ->
        raise ArgumentError, "BLOK_GRPC_TLS_CERT is set without BLOK_GRPC_TLS_KEY"

      {cert, key} ->
        %{
          cert: readable!("BLOK_GRPC_TLS_CERT", cert),
          key: readable!("BLOK_GRPC_TLS_KEY", key),
          ca: ca && readable!("BLOK_GRPC_TLS_CA", ca)
        }
    end
  end

  defp readable!(name, path) do
    if File.regular?(path),
      do: path,
      else: raise(ArgumentError, "#{name} must point at a readable file, got #{inspect(path)}")
  end

  defp presence(env, name) do
    case Map.get(env, name) do
      nil -> nil
      value -> if String.trim(value) == "", do: nil, else: value
    end
  end
end
