defmodule Blok.Endpoint do
  use GRPC.Endpoint

  intercept(GRPC.Server.Interceptors.Logger)
  run(Blok.Runtime.Service)
end
