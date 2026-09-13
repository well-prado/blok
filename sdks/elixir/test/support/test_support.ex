defmodule Blok.TestSupport do
  @moduledoc false

  alias Blok.Runtime.V1.{
    ExecuteOptions,
    ExecuteRequest,
    NodeRef,
    RuntimeState,
    TriggerInfo,
    WorkflowInfo
  }

  @doc "Build a canonical ExecuteRequest the way the runner would send one."
  def request(node_name, inputs \\ %{}, opts \\ []) do
    %ExecuteRequest{
      node: %NodeRef{name: node_name, type: "runtime.elixir", version: ""},
      inputs: Jason.encode!(inputs),
      trigger: %TriggerInfo{
        body: Jason.encode!(Keyword.get(opts, :body, %{})),
        headers: Keyword.get(opts, :headers, %{}),
        method: "POST",
        trigger_kind: "http"
      },
      state: %RuntimeState{env: Keyword.get(opts, :env, %{})},
      workflow: %WorkflowInfo{
        run_id: Keyword.get(opts, :run_id, "run-1"),
        name: Keyword.get(opts, :workflow, "wf-1"),
        path: "wf-1.ts"
      },
      options: %ExecuteOptions{deadline_ms: Keyword.get(opts, :deadline_ms, 5_000)}
    }
  end

  @doc "Register the calling process under a global binary name for fixtures."
  def listen(name) do
    :global.register_name(name, self())
    on_exit_unregister(name)
    name
  end

  defp on_exit_unregister(name) do
    ExUnit.Callbacks.on_exit(fn -> :global.unregister_name(name) end)
  end

  @doc "Poll until `fun` returns a truthy value or the budget expires."
  def wait_until(fun, timeout_ms \\ 2_000, step_ms \\ 10) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait(fun, deadline, step_ms)
  end

  defp do_wait(fun, deadline, step_ms) do
    case fun.() do
      falsy when falsy in [nil, false] ->
        if System.monotonic_time(:millisecond) >= deadline do
          false
        else
          Process.sleep(step_ms)
          do_wait(fun, deadline, step_ms)
        end

      value ->
        value
    end
  end
end
