defmodule Blok.Runtime.Service do
  use GRPC.Server, service: Blok.Runtime.V1.NodeRuntime.Service

  alias Blok.Runtime.V1.ExecuteEvent

  def execute(request, _stream), do: Blok.Runtime.execute(request)

  def execute_stream(request, stream) do
    GRPC.Server.send_reply(stream, %ExecuteEvent{event: {:started, Blok.Runtime.started_event()}})
    GRPC.Server.send_reply(stream, %ExecuteEvent{event: {:final, Blok.Runtime.execute(request)}})
  end

  def health(_request, _stream), do: Blok.Runtime.health()
  def list_nodes(_request, _stream), do: Blok.Runtime.list_nodes()
end
