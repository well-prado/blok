defmodule Blok.Context do
  @moduledoc "The documented node execution context projection."

  defstruct id: "",
            workflow_name: "",
            workflow_path: "",
            request: %{},
            response: %{},
            vars: %{},
            env: %{},
            deadline_at: nil,
            cancellation: nil,
            logger_metadata: %{}

  @type t :: %__MODULE__{}

  def cancelled?(%__MODULE__{cancellation: token, deadline_at: deadline}) do
    (token && Blok.Cancellation.cancelled?(token)) ||
      (deadline && System.monotonic_time(:millisecond) >= deadline)
  end

  def check_cancelled!(context) do
    if cancelled?(context),
      do:
        raise(Blok.Error,
          code: "NODE_CANCELLED",
          category: "CANCELLED",
          message: "node execution was cancelled"
        )

    :ok
  end

  def remaining_ms(%__MODULE__{deadline_at: nil}), do: :infinity

  def remaining_ms(%__MODULE__{deadline_at: deadline}),
    do: max(deadline - System.monotonic_time(:millisecond), 0)
end
