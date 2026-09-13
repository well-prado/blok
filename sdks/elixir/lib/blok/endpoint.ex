defmodule Blok.Endpoint do
  use GRPC.Endpoint

  # Per-request logging is a debug-level concern: at 10k req/s an info line per
  # call is the loudest thing in the container and costs real throughput.
  intercept(GRPC.Server.Interceptors.Logger, level: :debug)
  run(Blok.Runtime.Service)
end
