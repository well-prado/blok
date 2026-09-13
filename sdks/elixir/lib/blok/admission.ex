defmodule Blok.Admission do
  @moduledoc """
  Bounded execution admission for the BEAM sidecar.

  Requests never create unbounded tasks: both active executions and the pending
  queue have explicit limits. Each accepted job has a timer and a monitored
  caller, so deadlines and disconnected clients cannot leave orphan work.
  """

  use GenServer

  defstruct active: %{},
            queue: :queue.new(),
            max_concurrency: 16,
            max_queue: 64,
            accepting: true,
            grace_ms: 250,
            task_supervisor: Blok.ExecutionTaskSupervisor

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def run(fun, timeout_ms), do: run(__MODULE__, fun, timeout_ms)

  def run(server, fun, timeout_ms),
    do: GenServer.call(server, {:run, fun, timeout_ms}, timeout_ms + 1_000)

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)
  def stop_admission(server \\ __MODULE__), do: GenServer.call(server, :stop_admission)

  def drain(timeout_ms) when is_integer(timeout_ms), do: drain(__MODULE__, timeout_ms)

  def drain(server, timeout_ms),
    do: GenServer.call(server, {:drain, timeout_ms}, timeout_ms + 1_000)

  @impl true
  def init(opts) do
    {:ok,
     %__MODULE__{
       max_concurrency: Keyword.get(opts, :max_concurrency, 16),
       max_queue: Keyword.get(opts, :max_queue, 64),
       grace_ms: Keyword.get(opts, :cancellation_grace_ms, 250),
       task_supervisor: Keyword.get(opts, :task_supervisor, Blok.ExecutionTaskSupervisor)
     }}
  end

  @impl true
  def handle_call({:run, _fun, _timeout_ms}, _from, %{accepting: false} = state),
    do: {:reply, {:error, :draining}, state}

  def handle_call({:run, fun, timeout_ms}, from, state) do
    job = %{from: from, fun: fun, timeout_ms: max(timeout_ms, 1)}

    if map_size(state.active) < state.max_concurrency do
      {:noreply, start_job(job, state)}
    else
      if :queue.len(state.queue) >= state.max_queue do
        {:reply, {:error, :overloaded}, state}
      else
        {:noreply, %{state | queue: :queue.in(job, state.queue)}}
      end
    end
  end

  def handle_call(:snapshot, _from, state) do
    {:reply,
     %{
       active: map_size(state.active),
       queued: :queue.len(state.queue),
       accepting: state.accepting
     }, state}
  end

  def handle_call(:stop_admission, _from, state),
    do: {:reply, :ok, flush_queue(%{state | accepting: false})}

  def handle_call({:drain, timeout_ms}, from, state) do
    state = flush_queue(%{state | accepting: false})

    if map_size(state.active) == 0 do
      {:reply, :ok, state}
    else
      ref = Process.send_after(self(), {:drain_timeout, from}, max(timeout_ms, 1))
      {:noreply, Map.put(state, :drain_waiter, {from, ref})}
    end
  end

  @impl true
  def handle_info({:job_finished, job_ref, result}, state) do
    case Map.pop(state.active, job_ref) do
      {nil, _} ->
        {:noreply, state}

      {job, active} ->
        Process.cancel_timer(job.timer)
        Process.demonitor(job.monitor, [:flush])
        GenServer.reply(job.from, result)
        state = %{state | active: active} |> start_queued_job()
        maybe_finish_drain(state)
        {:noreply, state}
    end
  end

  def handle_info({:job_deadline, job_ref}, state) do
    case Map.pop(state.active, job_ref) do
      {nil, _} ->
        {:noreply, state}

      {job, active} ->
        Process.exit(job.pid, :kill)
        Process.demonitor(job.monitor, [:flush])
        GenServer.reply(job.from, {:error, :deadline_exceeded})
        state = %{state | active: active} |> start_queued_job()
        maybe_finish_drain(state)
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Enum.find(state.active, fn {_ref, job} -> job.monitor == monitor end) do
      {job_ref, job} ->
        Process.cancel_timer(job.timer)
        GenServer.reply(job.from, {:error, :execution_crashed})
        {:noreply, %{state | active: Map.delete(state.active, job_ref)} |> start_queued_job()}

      nil ->
        {:noreply, state}
    end
  end

  def handle_info({:drain_timeout, from}, state) do
    Enum.each(state.active, fn {_ref, job} -> Process.exit(job.pid, :kill) end)
    GenServer.reply(from, :timeout)
    {:noreply, %{state | active: %{}}}
  end

  defp start_job(job, state) do
    server = self()
    job_ref = make_ref()

    child =
      Task.Supervisor.start_child(state.task_supervisor, fn ->
        result =
          try do
            {:ok, job.fun.()}
          catch
            kind, reason -> {:error, {kind, reason, __STACKTRACE__}}
          end

        send(server, {:job_finished, job_ref, result})
      end)

    case child do
      {:ok, pid} ->
        monitor = Process.monitor(pid)
        timer = Process.send_after(self(), {:job_deadline, job_ref}, job.timeout_ms)

        %{
          state
          | active:
              Map.put(
                state.active,
                job_ref,
                Map.merge(job, %{pid: pid, monitor: monitor, timer: timer})
              )
        }

      # The task supervisor is its own ceiling. Never let it crash admission:
      # a saturated runtime answers deterministically instead of dying.
      {:error, _reason} ->
        GenServer.reply(job.from, {:error, :overloaded})
        state
    end
  end

  defp start_queued_job(%{accepting: false} = state), do: state

  defp start_queued_job(state) do
    if map_size(state.active) < state.max_concurrency do
      case :queue.out(state.queue) do
        {{:value, job}, queue} -> start_job(job, %{state | queue: queue}) |> start_queued_job()
        {:empty, _} -> state
      end
    else
      state
    end
  end

  defp maybe_finish_drain(%{drain_waiter: {from, timer}, active: active} = state)
       when map_size(active) == 0 do
    Process.cancel_timer(timer)
    GenServer.reply(from, :ok)
    Map.delete(state, :drain_waiter)
  end

  defp maybe_finish_drain(state), do: state

  # A queued job has no deadline timer yet, so a drain that simply stopped
  # dequeuing would leave its caller blocked until the call timeout. Answer now.
  defp flush_queue(state) do
    state.queue
    |> :queue.to_list()
    |> Enum.each(&GenServer.reply(&1.from, {:error, :draining}))

    %{state | queue: :queue.new()}
  end
end
