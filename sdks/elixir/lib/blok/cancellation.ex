defmodule Blok.Cancellation do
  @moduledoc "A process-safe cancellation token backed by an atomic flag."

  def new, do: :atomics.new(1, signed: false)
  def cancel(token), do: :atomics.put(token, 1, 1)
  def cancelled?(token), do: :atomics.get(token, 1) == 1
end
