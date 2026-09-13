defmodule Blok.TestNodes do
  @moduledoc """
  Failure-mode fixtures registered only in `:test`.

  They exist so the BEAM failure tests drive the real `Blok.Runtime.execute/1`
  path — registry lookup, admission, task supervision, error mapping — instead
  of asserting against a stubbed pipeline.
  """

  defmodule Input do
    use Blok.Schema

    field :sleep_ms, :integer, default: 0
    field :reply_to, :string, default: ""
  end

  defmodule Output do
    use Blok.Schema

    field :ok, :boolean, required: true
  end

  defmodule Boom do
    use Blok.Node, name: "test-raise", input: Input, output: Output

    @impl Blok.Node
    def execute(_ctx, _input), do: raise("node exploded")
  end

  defmodule Throw do
    use Blok.Node, name: "test-throw", input: Input, output: Output

    @impl Blok.Node
    def execute(_ctx, _input), do: throw(:thrown_value)
  end

  defmodule Exit do
    use Blok.Node, name: "test-exit", input: Input, output: Output

    @impl Blok.Node
    def execute(_ctx, _input), do: exit(:node_exit)
  end

  defmodule Sleep do
    use Blok.Node, name: "test-sleep", input: Input, output: Output

    @impl Blok.Node
    def execute(_ctx, input) do
      Blok.TestNodes.announce(input.reply_to, {:running, self(), Logger.metadata()})
      Process.sleep(input.sleep_ms)
      {:ok, %Output{ok: true}}
    end
  end

  defmodule SpawnChild do
    use Blok.Node, name: "test-spawn-child", input: Input, output: Output

    @impl Blok.Node
    def execute(_ctx, input) do
      {:ok, child} = Task.start_link(fn -> Process.sleep(:infinity) end)
      Blok.TestNodes.announce(input.reply_to, {:child, self(), child})
      Process.sleep(input.sleep_ms)
      {:ok, %Output{ok: true}}
    end
  end

  @doc false
  def announce("", _message), do: :ok

  def announce(name, message) do
    case :global.whereis_name(name) do
      :undefined -> :ok
      pid -> send(pid, message)
    end
  end
end
