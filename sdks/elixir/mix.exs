defmodule Blok.MixProject do
  use Mix.Project

  @version "0.1.0"

  def project do
    [
      app: :blok,
      version: @version,
      elixir: "~> 1.17",
      otp_release: "27",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      elixirc_paths: elixirc_paths(Mix.env()),
      aliases: aliases(),
      releases: releases(),
      docs: [main: "readme", extras: ["README.md"]]
    ]
  end

  def application do
    [extra_applications: [:logger], mod: {Blok.Application, []}]
  end

  defp deps do
    [
      # grpc_server 1.x contains the supervised stream-based server. grpc is
      # kept explicit because generated stubs and the public client API use it.
      {:grpc_server, "~> 1.0.5"},
      {:grpc, "~> 1.0.5"},
      {:protobuf, "~> 0.17.0"},
      {:protobuf_generate, "~> 0.2.1", only: :dev},
      # Client transport for `mix blok.bench` only. `grpc` declares it optional
      # because the sidecar itself never dials out; the release excludes it.
      {:gun, "~> 2.4", only: [:dev, :test]},
      {:jason, "~> 1.4"},
      {:ex_json_schema, "~> 0.11.5"},
      {:telemetry, "~> 1.3"}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp aliases do
    [
      "proto.generate": [
        "protobuf.generate --include-path=proto --output-path=lib --plugin=ProtobufGenerate.Plugins.GRPC proto/blok/runtime/v1/runtime.proto"
      ],
      check: ["format --check-formatted", "test"]
    ]
  end

  defp releases do
    [blok: [include_executable: true, applications: [runtime_tools: :permanent]]]
  end
end
