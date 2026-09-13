defmodule Blok.BeamFailureModesTest do
  @moduledoc """
  Deterministic coverage for the BEAM failure modes in issue #943.

  These tests drive the real `Blok.Runtime.execute/1` path (registry lookup,
  admission, task supervision, error mapping) on the running application, and
  use isolated `Blok.Admission` instances only where a test needs a capacity
  small enough to saturate deterministically.
  """

  use ExUnit.Case, async: false

  import Blok.TestSupport

  alias Blok.Runtime.V1.{ExecuteOptions, ExecuteRequest, NodeRef}

  describe "concurrent request isolation" do
    test "a crashing node never disturbs concurrent healthy executions" do
      tasks =
        for index <- 1..12 do
          Task.async(fn ->
            if rem(index, 2) == 0 do
              {:crash, Blok.Runtime.execute(request("test-raise"))}
            else
              {:ok, Blok.Runtime.execute(request("typed-greet", %{"name" => "n#{index}"}))}
            end
          end)
        end

      results = Task.await_many(tasks, 10_000)

      for {:ok, response} <- results do
        assert response.success
        assert Jason.decode!(response.data)["greeting"] =~ "Hello, n"
      end

      for {:crash, response} <- results do
        refute response.success
        assert response.error.node == "test-raise"
      end
    end
  end

  describe "bounded processes, queue and overload" do
    setup do
      tasks = start_supervised!({Task.Supervisor, max_children: 2}, id: :burst_tasks)

      admission =
        start_supervised!(
          {Blok.Admission, name: nil, max_concurrency: 2, max_queue: 2, task_supervisor: tasks},
          id: :burst_admission
        )

      %{admission: admission, tasks: tasks}
    end

    test "a burst larger than concurrency+queue is rejected deterministically", context do
      %{admission: admission, tasks: tasks} = context
      parent = self()

      callers =
        for _ <- 1..20 do
          Task.async(fn ->
            Blok.Admission.run(
              admission,
              fn ->
                send(parent, {:job, self()})

                receive do
                  :release -> :done
                end
              end,
              5_000
            )
          end)
        end

      # Two jobs run, two wait; the other sixteen are refused immediately.
      assert wait_until(fn -> Blok.Admission.snapshot(admission).queued == 2 end)
      snapshot = Blok.Admission.snapshot(admission)
      assert snapshot.active == 2
      assert snapshot.queued == 2
      assert length(Task.Supervisor.children(tasks)) == 2
      assert :erlang.process_info(admission, :message_queue_len) == {:message_queue_len, 0}

      release_all()
      results = Task.await_many(callers, 10_000)

      assert Enum.count(results, &(&1 == {:ok, :done})) == 4
      assert Enum.count(results, &(&1 == {:error, :overloaded})) == 16
      assert Blok.Admission.snapshot(admission) == %{active: 0, queued: 0, accepting: true}
    end

    test "the queue never grows past its bound while a burst is in flight", context do
      %{admission: admission} = context
      parent = self()

      callers =
        for _ <- 1..30 do
          Task.async(fn ->
            Blok.Admission.run(
              admission,
              fn ->
                send(parent, {:job, self()})

                receive do
                  :release -> :done
                end
              end,
              5_000
            )
          end)
        end

      peaks =
        for _ <- 1..30 do
          Process.sleep(5)
          {:message_queue_len, mailbox} = :erlang.process_info(admission, :message_queue_len)
          snapshot = Blok.Admission.snapshot(admission)
          {snapshot.active, snapshot.queued, mailbox}
        end

      assert Enum.all?(peaks, fn {active, queued, mailbox} ->
               active <= 2 and queued <= 2 and mailbox <= 30
             end)

      release_all()
      Task.await_many(callers, 10_000)
    end

    test "a saturated runtime answers RUNTIME_OVERLOADED over the real execute path" do
      config = Application.get_env(:blok, :config)
      capacity = config.max_concurrency + config.max_queue

      callers =
        for _ <- 1..(capacity + 20) do
          Task.async(fn -> Blok.Runtime.execute(request("test-sleep", %{"sleep_ms" => 400})) end)
        end

      assert wait_until(fn ->
               length(Task.Supervisor.children(Blok.ExecutionTaskSupervisor)) ==
                 config.max_concurrency
             end)

      responses = Task.await_many(callers, 20_000)
      {ok, refused} = Enum.split_with(responses, & &1.success)

      assert length(ok) == capacity
      assert length(refused) == 20

      for response <- refused do
        assert response.error.code == "RUNTIME_OVERLOADED"
        assert response.error.category == :RATE_LIMIT
        assert response.error.retryable
        assert response.error.retry_after_ms > 0
      end

      assert wait_until(fn ->
               Blok.Admission.snapshot() == %{active: 0, queued: 0, accepting: true}
             end)
    end
  end

  describe "node failures become structured errors" do
    test "raise, throw and exit map to distinct structured errors without killing the runtime" do
      supervisor_before = supervisor_pids()

      expectations = [
        {"test-raise", "NODE_ERROR", :INTERNAL},
        {"test-throw", "NODE_THROW", :INTERNAL},
        {"test-exit", "NODE_EXIT", :INTERNAL}
      ]

      for {node, code, category} <- expectations do
        response = Blok.Runtime.execute(request(node))
        refute response.success
        assert response.error.code == code
        assert response.error.category == category
        assert response.error.node == node
        assert response.error.runtime_kind == "runtime.elixir"
        assert response.error.sdk == "blok-elixir"
      end

      assert supervisor_pids() == supervisor_before
      assert %{success: true} = Blok.Runtime.execute(request("typed-greet", %{"name" => "Ada"}))
    end

    test "a sparse request projects to an empty context instead of crashing the endpoint" do
      supervisor_before = supervisor_pids()

      sparse = %ExecuteRequest{
        node: %NodeRef{name: "typed-greet", type: "runtime.elixir"},
        inputs: Jason.encode!(%{"name" => "Ada"}),
        options: %ExecuteOptions{deadline_ms: 1_000}
      }

      assert %{success: true} = Blok.Runtime.execute(sparse)
      assert supervisor_pids() == supervisor_before
    end

    test "an externally killed execution process becomes NODE_PROCESS_CRASH" do
      name = listen("crash-isolation")
      supervisor_before = supervisor_pids()

      caller =
        Task.async(fn ->
          Blok.Runtime.execute(request("test-sleep", %{"sleep_ms" => 5_000, "reply_to" => name}))
        end)

      assert_receive {:running, pid, _metadata}, 2_000
      Process.exit(pid, :kill)

      response = Task.await(caller, 5_000)
      refute response.success
      assert response.error.code == "NODE_PROCESS_CRASH"
      assert supervisor_pids() == supervisor_before

      assert %{success: true} = Blok.Runtime.execute(request("typed-greet", %{"name" => "Ada"}))
    end
  end

  describe "deadlines and cancellation" do
    test "a deadline terminates the execution within a bounded time" do
      started = System.monotonic_time(:millisecond)

      response =
        Blok.Runtime.execute(request("test-sleep", %{"sleep_ms" => 10_000}, deadline_ms: 200))

      elapsed = System.monotonic_time(:millisecond) - started

      refute response.success
      assert response.error.code == "NODE_DEADLINE_EXCEEDED"
      assert response.error.category == :TIMEOUT
      assert elapsed < 2_000, "deadline enforcement took #{elapsed}ms"
    end

    test "descendants of a timed-out node are cleaned up, not orphaned" do
      name = listen("descendant-cleanup")

      response =
        Blok.Runtime.execute(
          request("test-spawn-child", %{"sleep_ms" => 10_000, "reply_to" => name},
            deadline_ms: 200
          )
        )

      refute response.success
      assert_received {:child, job, child}
      assert wait_until(fn -> not Process.alive?(job) end)
      assert wait_until(fn -> not Process.alive?(child) end)
    end

    test "the cancellation token and deadline are visible to node code" do
      token = Blok.Cancellation.new()
      context = %Blok.Context{cancellation: token, deadline_at: nil}

      refute Blok.Context.cancelled?(context)
      assert Blok.Context.check_cancelled!(context) == :ok

      Blok.Cancellation.cancel(token)
      assert Blok.Context.cancelled?(context)

      assert_raise Blok.Error, fn -> Blok.Context.check_cancelled!(context) end

      expired = %Blok.Context{deadline_at: System.monotonic_time(:millisecond) - 1}
      assert Blok.Context.cancelled?(expired)
      assert Blok.Context.remaining_ms(expired) == 0
    end
  end

  describe "supervision and drain" do
    test "killing the admission process does not stop the runtime from serving" do
      admission = Process.whereis(Blok.Admission)
      others_before = Enum.sort(supervisor_pids() -- [admission])
      Process.exit(admission, :kill)

      restarted =
        wait_until(fn ->
          pid = Process.whereis(Blok.Admission)
          pid && pid != admission && pid
        end)

      assert is_pid(restarted)
      assert %{success: true} = Blok.Runtime.execute(request("typed-greet", %{"name" => "Ada"}))
      # one_for_one: the gRPC endpoint and registry are untouched by the restart.
      assert Enum.sort(supervisor_pids() -- [restarted]) == others_before
    end

    test "a drain lets in-flight work finish while new requests are refused" do
      name = listen("drain-inflight")

      inflight =
        Task.async(fn ->
          Blok.Runtime.execute(request("test-sleep", %{"sleep_ms" => 300, "reply_to" => name}))
        end)

      assert_receive {:running, _pid, _metadata}, 2_000
      assert :ok = Blok.Admission.stop_admission()

      refused = Blok.Runtime.execute(request("typed-greet", %{"name" => "Ada"}))
      refute refused.success
      assert refused.error.code == "RUNTIME_DRAINING"
      assert refused.error.category == :CANCELLED

      assert %{success: true} = Task.await(inflight, 5_000)
      assert Blok.Runtime.health().status == :NOT_SERVING

      restart_admission()
      assert Blok.Runtime.health().status == :SERVING
    end

    test "draining answers queued work instead of stranding it" do
      tasks = start_supervised!({Task.Supervisor, max_children: 1}, id: :drain_tasks)

      admission =
        start_supervised!(
          {Blok.Admission, name: nil, max_concurrency: 1, max_queue: 4, task_supervisor: tasks},
          id: :drain_admission
        )

      parent = self()

      callers =
        for _ <- 1..3 do
          Task.async(fn ->
            Blok.Admission.run(
              admission,
              fn ->
                send(parent, {:job, self()})

                receive do
                  :release -> :done
                end
              end,
              5_000
            )
          end)
        end

      assert wait_until(fn -> Blok.Admission.snapshot(admission).queued == 2 end)
      assert :ok = Blok.Admission.stop_admission(admission)

      release_all()
      results = Task.await_many(callers, 10_000)

      assert Enum.count(results, &(&1 == {:ok, :done})) == 1
      assert Enum.count(results, &(&1 == {:error, :draining})) == 2
    end
  end

  describe "atom table safety" do
    test "adversarial node names, JSON keys and headers never create atoms" do
      # Warm the code paths first: module loading itself creates atoms.
      _ = Blok.Runtime.execute(request("warmup-unknown-node", %{"warmup_key" => 1}))
      _ = Blok.Runtime.execute(request("typed-greet", %{"name" => "warm"}))

      before = :erlang.system_info(:atom_count)

      for index <- 1..50 do
        adversarial = "adversarial_atom_943_#{index}"

        _ = Blok.Runtime.execute(request(adversarial, %{adversarial => adversarial}))

        _ =
          Blok.Runtime.execute(
            request("typed-greet", %{"name" => "Ada", adversarial => true},
              headers: %{adversarial => adversarial},
              run_id: adversarial,
              workflow: adversarial
            )
          )
      end

      assert :erlang.system_info(:atom_count) == before
    end

    test "an unknown node is a structured NOT_FOUND, not a crash" do
      response = Blok.Runtime.execute(request("no-such-node-943"))
      refute response.success
      assert response.error.code == "NODE_NOT_FOUND"
      assert response.error.category == :NOT_FOUND
    end
  end

  describe "secret and payload redaction" do
    test "env values and node payloads never reach logs or error metadata" do
      secret = "tok_live_943_should_never_appear"

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          response =
            Blok.Runtime.execute(
              request("test-raise", %{"sleep_ms" => 1},
                env: %{"API_TOKEN" => secret},
                headers: %{"authorization" => "Bearer #{secret}"}
              )
            )

          refute response.success
          refute response.error.message =~ secret
          refute response.error.details_json =~ secret
        end)

      refute log =~ secret
    end

    test "structured logging redacts secret-shaped keys and bounds large values" do
      context = %{logger_metadata: %{run_id: "run-1"}}

      log =
        ExUnit.CaptureLog.capture_log([metadata: :all], fn ->
          Blok.Logger.info(context, "handled",
            authorization: "Bearer leak",
            api_token: "tok_live_leak",
            payload: String.duplicate("x", 4096)
          )
        end)

      refute log =~ "leak"
      refute log =~ String.duplicate("x", 3000)
    end

    test "a crash reason carrying a payload is bounded before it becomes an error" do
      payload = String.duplicate("p", 10_000)
      assert byte_size(Blok.Logger.safe_inspect(%{payload: payload})) <= 600
    end
  end

  defp release_all do
    receive do
      {:job, pid} ->
        send(pid, :release)
        release_all()
    after
      50 -> :ok
    end
  end

  defp restart_admission do
    admission = Process.whereis(Blok.Admission)
    Process.exit(admission, :kill)

    assert wait_until(fn ->
             pid = Process.whereis(Blok.Admission)
             pid && pid != admission && Blok.Admission.snapshot().accepting
           end)
  end

  defp supervisor_pids,
    do: Blok.Supervisor |> Supervisor.which_children() |> Enum.map(&elem(&1, 1))
end
