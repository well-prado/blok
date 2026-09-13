defmodule Blok.TelemetryTest do
  use ExUnit.Case, async: false

  import Blok.TestSupport

  setup context do
    parent = self()
    handler = "telemetry-test-#{inspect(context.test)}"

    :telemetry.attach_many(
      handler,
      Blok.Telemetry.events(),
      fn event, measurements, metadata, _ ->
        send(parent, {:telemetry, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    :ok
  end

  test "a successful execution emits start and stop with duration and queue time" do
    assert %{success: true} = Blok.Runtime.execute(request("typed-greet", %{"name" => "Ada"}))

    assert_receive {:telemetry, [:blok, :execution, :start], start_measurements, start_metadata}
    assert_receive {:telemetry, [:blok, :execution, :stop], stop_measurements, stop_metadata}

    assert is_integer(start_measurements.system_time)
    assert start_measurements.queue_time_ms >= 0
    assert stop_measurements.duration_ms >= 0
    assert stop_measurements.queue_time_ms >= 0

    assert start_metadata == %{node: "typed-greet", run_id: "run-1", workflow: "wf-1"}
    assert stop_metadata.result == :ok
  end

  test "a failing node still stops, tagged as an error" do
    assert %{success: false} = Blok.Runtime.execute(request("test-raise"))

    assert_receive {:telemetry, [:blok, :execution, :stop], _measurements, metadata}
    assert metadata.result == :error
    assert metadata.node == "test-raise"
  end

  test "an exception inside the span is reported and re-raised with a bounded reason" do
    secret = String.duplicate("s3cr3t", 500)

    assert_raise RuntimeError, fn ->
      Blok.Telemetry.span(%{node: "n", run_id: "r", workflow: "w"}, 1, fn ->
        raise secret
      end)
    end

    assert_receive {:telemetry, [:blok, :execution, :exception], measurements, metadata}
    assert measurements.duration_ms >= 0
    assert measurements.queue_time_ms == 1
    assert metadata.kind == :error
    assert byte_size(metadata.reason) <= 600
  end

  test "telemetry metadata never carries inputs, env, headers or output" do
    Blok.Runtime.execute(
      request("typed-greet", %{"name" => "Ada"},
        env: %{"API_TOKEN" => "tok_live_should_never_appear"},
        headers: %{"authorization" => "Bearer leak-me"}
      )
    )

    assert_receive {:telemetry, [:blok, :execution, :start], _, start_metadata}
    assert_receive {:telemetry, [:blok, :execution, :stop], _, stop_metadata}

    assert Map.keys(start_metadata) |> Enum.sort() == [:node, :run_id, :workflow]
    assert Map.keys(stop_metadata) |> Enum.sort() == [:node, :result, :run_id, :workflow]

    refute inspect({start_metadata, stop_metadata}) =~ "tok_live"
    refute inspect({start_metadata, stop_metadata}) =~ "leak-me"
  end

  test "Logger metadata inside the execution carries run, node and workflow" do
    name = listen("telemetry-logger-metadata")

    assert %{success: true} =
             Blok.Runtime.execute(
               request("test-sleep", %{"sleep_ms" => 0, "reply_to" => name}, run_id: "run-42")
             )

    assert_receive {:running, _pid, metadata}
    assert metadata[:run_id] == "run-42"
    assert metadata[:node] == "test-sleep"
    assert metadata[:workflow] == "wf-1"
  end
end
