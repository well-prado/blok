defmodule Blok.Telemetry do
  @moduledoc """
  Execution telemetry for `runtime.elixir`.

  Events (all under the `[:blok, :execution]` prefix):

    * `[:blok, :execution, :start]` — measurements `%{system_time, queue_time_ms}`
    * `[:blok, :execution, :stop]` — measurements `%{duration_ms, queue_time_ms}`,
      metadata adds `:result` (`:ok` | `:error`)
    * `[:blok, :execution, :exception]` — measurements `%{duration_ms, queue_time_ms}`,
      metadata adds `:kind` and a bounded `:reason`

  Metadata carries only `:node`, `:run_id`, and `:workflow`. Inputs, env values,
  headers, and node output never enter telemetry or Logger metadata: a handler
  is an arbitrary third-party callback and must not become a payload sink.
  """

  @prefix [:blok, :execution]

  @spec events() :: [[atom()]]
  def events, do: Enum.map([:start, :stop, :exception], &(@prefix ++ [&1]))

  @doc """
  Run `fun` inside an execution span, emitting start/stop/exception events.

  `queue_time_ms` is the admission wait measured by the caller, so a saturated
  sidecar reports latency that the handler can split into queueing and work.
  """
  @spec span(map(), number(), (-> result)) :: result when result: term()
  def span(metadata, queue_time_ms, fun) do
    metadata = Map.take(metadata, [:node, :run_id, :workflow])
    started_at = System.monotonic_time()

    :telemetry.execute(
      @prefix ++ [:start],
      %{system_time: System.system_time(), queue_time_ms: queue_time_ms},
      metadata
    )

    try do
      result = fun.()

      :telemetry.execute(
        @prefix ++ [:stop],
        measurements(started_at, queue_time_ms),
        Map.put(metadata, :result, result_tag(result))
      )

      result
    catch
      kind, reason ->
        :telemetry.execute(
          @prefix ++ [:exception],
          measurements(started_at, queue_time_ms),
          Map.merge(metadata, %{kind: kind, reason: Blok.Logger.safe_inspect(reason)})
        )

        :erlang.raise(kind, reason, __STACKTRACE__)
    end
  end

  defp measurements(started_at, queue_time_ms),
    do: %{duration_ms: elapsed_ms(started_at), queue_time_ms: queue_time_ms}

  @doc false
  def elapsed_ms(started_at),
    do:
      System.convert_time_unit(System.monotonic_time() - started_at, :native, :microsecond) / 1000

  defp result_tag(%Blok.Runtime.V1.ExecuteResponse{success: true}), do: :ok
  defp result_tag(_), do: :error
end
