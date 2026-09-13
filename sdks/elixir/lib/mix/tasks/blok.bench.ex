defmodule Mix.Tasks.Blok.Bench do
  @shortdoc "Drive typed-greet over real gRPC and print a load profile"

  @moduledoc """
  Repeatable load profile for the Elixir sidecar.

      mix blok.bench --concurrency 32 --duration 10

  The task boots the sidecar in this VM, opens one gRPC channel per worker, and
  drives the canonical `typed-greet` node over the wire for the requested
  duration. It prints throughput, p50/p95/p99 latency, admission queue time
  (from `[:blok, :execution, :stop]` telemetry), peak process count, scheduler
  utilisation, reductions, memory, and error rate.

  Options:

    * `--concurrency` — concurrent gRPC clients (default `16`)
    * `--duration` — seconds of steady load (default `10`)
    * `--warmup` — seconds of discarded warm-up load (default `2`)
    * `--port` — sidecar port (default: the configured `GRPC_PORT`)
  """

  use Mix.Task

  alias Blok.Runtime.V1.{ExecuteOptions, ExecuteRequest, NodeRef, WorkflowInfo}

  @handler "blok-bench-queue-time"

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} =
      OptionParser.parse(argv,
        strict: [concurrency: :integer, duration: :integer, warmup: :integer, port: :integer]
      )

    Mix.Task.run("app.start")

    concurrency = Keyword.get(opts, :concurrency, 16)
    duration_ms = Keyword.get(opts, :duration, 10) * 1_000
    warmup_ms = Keyword.get(opts, :warmup, 2) * 1_000
    port = Keyword.get(opts, :port) || Application.get_env(:blok, :config).port

    channels = Enum.map(1..concurrency, fn _ -> connect!(port) end)
    queue_times = :ets.new(:bench_queue_times, [:public, :duplicate_bag])
    attach_queue_time_handler(queue_times)

    if warmup_ms > 0, do: drive(channels, warmup_ms)

    :erlang.system_flag(:scheduler_wall_time, true)
    :ets.delete_all_objects(queue_times)
    schedulers_before = :erlang.statistics(:scheduler_wall_time)
    {reductions_before, _} = :erlang.statistics(:reductions)
    sampler = start_sampler()

    started_at = System.monotonic_time(:millisecond)
    samples = drive(channels, duration_ms)
    elapsed_ms = System.monotonic_time(:millisecond) - started_at

    {reductions, _} = :erlang.statistics(:reductions)
    schedulers_after = :erlang.statistics(:scheduler_wall_time)
    peak_processes = stop_sampler(sampler)
    :telemetry.detach(@handler)
    Enum.each(channels, &GRPC.Stub.disconnect/1)

    report(
      concurrency: concurrency,
      elapsed_ms: elapsed_ms,
      samples: samples,
      queue_times: :ets.tab2list(queue_times) |> Enum.map(&elem(&1, 1)),
      reductions: reductions - reductions_before,
      scheduler_utilisation: scheduler_utilisation(schedulers_before, schedulers_after),
      peak_processes: peak_processes,
      port: port
    )
  end

  defp connect!(port) do
    case GRPC.Stub.connect("127.0.0.1:#{port}") do
      {:ok, channel} ->
        channel

      {:error, reason} ->
        Mix.raise("could not reach the sidecar on port #{port}: #{inspect(reason)}")
    end
  end

  defp attach_queue_time_handler(table) do
    :telemetry.attach(
      @handler,
      [:blok, :execution, :stop],
      fn _event, measurements, _metadata, _config ->
        :ets.insert(table, {:queue_time, measurements.queue_time_ms})
      end,
      nil
    )
  end

  defp drive(channels, duration_ms) do
    deadline = System.monotonic_time(:millisecond) + duration_ms

    channels
    |> Enum.map(fn channel -> Task.async(fn -> worker(channel, deadline, [], %{}) end) end)
    |> Task.await_many(duration_ms + 30_000)
    |> Enum.reduce({[], %{}}, fn {latencies, errors}, {all, all_errors} ->
      {latencies ++ all, Map.merge(all_errors, errors, fn _code, a, b -> a + b end)}
    end)
  end

  defp worker(channel, deadline, latencies, errors) do
    if System.monotonic_time(:millisecond) >= deadline do
      {latencies, errors}
    else
      started_at = System.monotonic_time(:microsecond)
      result = Blok.Runtime.V1.NodeRuntime.Stub.execute(channel, request())
      latency = System.monotonic_time(:microsecond) - started_at

      errors =
        case result do
          {:ok, %{success: true}} -> errors
          {:ok, %{error: %{code: code}}} -> Map.update(errors, code, 1, &(&1 + 1))
          {:error, %{message: message}} -> Map.update(errors, message, 1, &(&1 + 1))
          _ -> Map.update(errors, "unknown", 1, &(&1 + 1))
        end

      worker(channel, deadline, [latency | latencies], errors)
    end
  end

  defp request do
    %ExecuteRequest{
      node: %NodeRef{name: "typed-greet", type: "runtime.elixir"},
      inputs: Jason.encode!(%{"name" => "bench", "repeat" => 1}),
      workflow: %WorkflowInfo{run_id: "bench", name: "bench"},
      options: %ExecuteOptions{deadline_ms: 30_000}
    }
  end

  defp start_sampler do
    parent = self()

    spawn(fn ->
      sample_processes(parent, :erlang.system_info(:process_count))
    end)
  end

  defp sample_processes(parent, peak) do
    receive do
      {:stop, from} -> send(from, {:peak, peak})
    after
      50 -> sample_processes(parent, max(peak, :erlang.system_info(:process_count)))
    end
  end

  defp stop_sampler(sampler) do
    send(sampler, {:stop, self()})

    receive do
      {:peak, peak} -> peak
    after
      1_000 -> :erlang.system_info(:process_count)
    end
  end

  defp scheduler_utilisation(before, later) when not is_list(before) or not is_list(later),
    do: 0.0

  defp scheduler_utilisation(before, later) do
    {active, total} =
      Enum.zip(Enum.sort(before), Enum.sort(later))
      |> Enum.reduce({0, 0}, fn {{_id0, a0, t0}, {_id1, a1, t1}}, {active, total} ->
        {active + (a1 - a0), total + (t1 - t0)}
      end)

    if total == 0, do: 0.0, else: active / total * 100
  end

  defp report(data) do
    {latencies, errors} = data[:samples]
    sorted = Enum.sort(latencies)
    count = length(sorted)
    seconds = data[:elapsed_ms] / 1000
    queue_times = data[:queue_times]

    Mix.shell().info("""

    Blok Elixir sidecar load profile
    ================================
    port                 #{data[:port]}
    concurrency          #{data[:concurrency]}
    duration             #{Float.round(seconds, 2)} s
    requests             #{count}
    errors               #{error_count(errors)} (#{percent(error_count(errors), count)}%) #{inspect(errors)}
    throughput           #{Float.round(count / max(seconds, 0.001), 1)} req/s
    latency p50          #{ms(percentile(sorted, 0.50))} ms
    latency p95          #{ms(percentile(sorted, 0.95))} ms
    latency p99          #{ms(percentile(sorted, 0.99))} ms
    latency max          #{ms(List.last(sorted) || 0)} ms
    queue time p50       #{round3(percentile(Enum.sort(queue_times), 0.50))} ms
    queue time p99       #{round3(percentile(Enum.sort(queue_times), 0.99))} ms
    peak processes       #{data[:peak_processes]}
    scheduler util       #{Float.round(data[:scheduler_utilisation], 1)} %
    reductions           #{data[:reductions]}
    memory total         #{div(:erlang.memory(:total), 1024 * 1024)} MiB
    memory processes     #{div(:erlang.memory(:processes), 1024 * 1024)} MiB
    OTP / Elixir         #{:erlang.system_info(:otp_release)} / #{System.version()}
    schedulers online    #{:erlang.system_info(:schedulers_online)}
    """)
  end

  defp percentile([], _), do: 0

  defp percentile(sorted, fraction),
    do: Enum.at(sorted, min(round(length(sorted) * fraction), length(sorted) - 1))

  defp ms(microseconds) when is_number(microseconds), do: Float.round(microseconds / 1000, 3)
  defp round3(value) when is_number(value), do: Float.round(value / 1, 3)
  defp error_count(errors), do: errors |> Map.values() |> Enum.sum()
  defp percent(_part, 0), do: 0.0
  defp percent(part, total), do: Float.round(part / total * 100, 3)
end
