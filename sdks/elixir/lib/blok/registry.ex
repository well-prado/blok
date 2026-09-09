defmodule Blok.Registry do
  use GenServer

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  def list, do: GenServer.call(__MODULE__, :list)
  def get(name), do: GenServer.call(__MODULE__, {:get, name})

  @impl true
  def init(opts) do
    nodes = Keyword.get(opts, :nodes, [])

    with :ok <- validate_nodes(nodes) do
      {:ok, Map.new(nodes, fn module -> {module.__blok_node__().name, module} end)}
    end
  end

  @impl true
  def handle_call(:list, _from, state),
    do: {:reply, state |> Map.values() |> Enum.sort_by(& &1.__blok_node__().name), state}

  def handle_call({:get, name}, _from, state) when is_binary(name),
    do: {:reply, Map.get(state, name), state}

  defp validate_nodes(nodes) do
    names = Enum.map(nodes, & &1.__blok_node__().name)

    cond do
      not Enum.all?(nodes, &function_exported?(&1, :__blok_node__, 0)) ->
        {:stop, {:invalid_node, nodes}}

      length(names) != length(Enum.uniq(names)) ->
        {:stop, {:duplicate_node, names}}

      true ->
        :ok
    end
  end
end
