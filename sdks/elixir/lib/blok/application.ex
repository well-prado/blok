defmodule Blok.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Task.Supervisor,
       name: Blok.ExecutionTaskSupervisor,
       max_children: Application.get_env(:blok, :max_concurrency, 16)},
      {Blok.Registry, nodes: Application.get_env(:blok, :nodes, [])},
      {Blok.Admission,
       max_concurrency: Application.get_env(:blok, :max_concurrency, 16),
       max_queue: Application.get_env(:blok, :max_queue, 64),
       cancellation_grace_ms: Application.get_env(:blok, :cancellation_grace_ms, 250)},
      {GRPC.Server.Supervisor,
       endpoint: Blok.Endpoint,
       port: Application.get_env(:blok, :port, 10010),
       start_server: true,
       max_body_size: Application.get_env(:blok, :max_message_bytes, 16 * 1024 * 1024),
       adapter_opts: adapter_opts()}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Blok.Supervisor)
  end

  @impl true
  def prep_stop(_state) do
    _ = Blok.Admission.stop_admission()
    _ = Blok.Admission.drain(Application.get_env(:blok, :cancellation_grace_ms, 250) + 5_000)
    :ok
  end

  defp adapter_opts do
    opts = [
      ip: parse_ip(System.get_env("HOST", "0.0.0.0")),
      max_connections: env_integer("BLOK_GRPC_MAX_CONNECTIONS", 256)
    ]

    case {System.get_env("BLOK_GRPC_TLS_CERT"), System.get_env("BLOK_GRPC_TLS_KEY")} do
      {cert, key} when is_binary(cert) and is_binary(key) ->
        Keyword.put(
          opts,
          :cred,
          GRPC.Credential.new(
            ssl: [certfile: cert, keyfile: key, cacertfile: System.get_env("BLOK_GRPC_TLS_CA")]
          )
        )

      _ ->
        opts
    end
  end

  defp parse_ip("0.0.0.0"), do: {0, 0, 0, 0}
  defp parse_ip("::"), do: {0, 0, 0, 0, 0, 0, 0, 0}

  defp parse_ip(value) do
    case :inet.parse_address(String.to_charlist(value)) do
      {:ok, address} -> address
      _ -> {127, 0, 0, 1}
    end
  end

  defp env_integer(name, default) do
    case Integer.parse(System.get_env(name, "")) do
      {value, ""} when value > 0 -> value
      _ -> default
    end
  end
end
