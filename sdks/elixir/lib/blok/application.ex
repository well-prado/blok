defmodule Blok.Application do
  use Application

  @impl true
  def start(_type, _args) do
    config = Blok.Config.load!()
    Application.put_env(:blok, :config, config)
    Logger.configure(level: config.log_level)

    children = [
      # A safety net above admission, never the binding limit: a task that has
      # already replied can still be terminating, and an equal ceiling would
      # turn that overlap into a spurious RUNTIME_OVERLOADED.
      {Task.Supervisor,
       name: Blok.ExecutionTaskSupervisor, max_children: config.max_concurrency + config.max_queue},
      {Blok.Registry, nodes: Application.get_env(:blok, :nodes, [])},
      {Blok.Admission,
       max_concurrency: config.max_concurrency,
       max_queue: config.max_queue,
       cancellation_grace_ms: config.cancellation_grace_ms},
      {GRPC.Server.Supervisor, Blok.Config.server_opts(config)}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Blok.Supervisor)
  end

  @impl true
  def prep_stop(state) do
    grace = Application.get_env(:blok, :config, %Blok.Config{}).cancellation_grace_ms
    _ = Blok.Admission.stop_admission()
    _ = Blok.Admission.drain(grace + 5_000)
    state
  end
end
