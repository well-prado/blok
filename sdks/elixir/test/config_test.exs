defmodule Blok.ConfigTest do
  use ExUnit.Case, async: true

  alias Blok.Config

  @tls_dir Path.join(System.tmp_dir!(), "blok-elixir-config-test")

  setup_all do
    File.mkdir_p!(@tls_dir)
    cert = Path.join(@tls_dir, "server.crt")
    key = Path.join(@tls_dir, "server.key")
    ca = Path.join(@tls_dir, "ca.crt")
    Enum.each([cert, key, ca], &File.write!(&1, "not-a-real-pem"))
    on_exit(fn -> File.rm_rf!(@tls_dir) end)
    %{cert: cert, key: key, ca: ca}
  end

  test "defaults match the documented sidecar contract" do
    config = Config.load!(%{})

    assert config.port == 10_010
    assert config.host == "0.0.0.0"
    assert config.ip == {0, 0, 0, 0}
    assert config.max_message_bytes == 16 * 1024 * 1024
    assert config.keepalive_time_ms == 10_000
    assert config.keepalive_timeout_ms == 5_000
    assert config.max_connections == 256
    assert config.max_concurrency == 16
    assert config.max_queue == 64
    assert config.tls == nil
  end

  test "every knob is environment configurable" do
    config =
      Config.load!(%{
        "HOST" => "127.0.0.1",
        "GRPC_PORT" => "20010",
        "BLOK_GRPC_MAX_MESSAGE_BYTES" => "1048576",
        "BLOK_GRPC_KEEPALIVE_TIME_MS" => "7000",
        "BLOK_GRPC_KEEPALIVE_TIMEOUT_MS" => "3000",
        "BLOK_GRPC_MAX_CONNECTIONS" => "32",
        "BLOK_ELIXIR_MAX_CONCURRENCY" => "4",
        "BLOK_ELIXIR_MAX_QUEUE" => "8",
        "BLOK_ELIXIR_CANCELLATION_GRACE_MS" => "500"
      })

    assert config.ip == {127, 0, 0, 1}
    assert config.port == 20_010
    assert config.max_message_bytes == 1_048_576
    assert config.keepalive_time_ms == 7_000
    assert config.keepalive_timeout_ms == 3_000
    assert config.max_connections == 32
    assert config.max_concurrency == 4
    assert config.max_queue == 8
    assert config.cancellation_grace_ms == 500
  end

  test "RUNTIME_ELIXIR_GRPC_PORT is the documented fallback and GRPC_PORT wins" do
    assert Config.load!(%{"RUNTIME_ELIXIR_GRPC_PORT" => "10999"}).port == 10_999

    assert Config.load!(%{"RUNTIME_ELIXIR_GRPC_PORT" => "10999", "GRPC_PORT" => "11000"}).port ==
             11_000
  end

  test "malformed numbers fail the boot instead of silently defaulting" do
    for {name, value} <- [
          {"GRPC_PORT", "not-a-port"},
          {"GRPC_PORT", "0"},
          {"GRPC_PORT", "-1"},
          {"BLOK_GRPC_MAX_MESSAGE_BYTES", "16MB"},
          {"BLOK_GRPC_KEEPALIVE_TIME_MS", "10s"},
          {"BLOK_GRPC_KEEPALIVE_TIMEOUT_MS", "5.5"},
          {"BLOK_ELIXIR_MAX_CONCURRENCY", "many"},
          {"BLOK_ELIXIR_MAX_QUEUE", "0"}
        ] do
      assert_raise ArgumentError, ~r/#{name} must be a positive integer/, fn ->
        Config.load!(%{name => value})
      end
    end

    assert_raise ArgumentError, ~r/between 1 and 65535/, fn ->
      Config.load!(%{"GRPC_PORT" => "70000"})
    end
  end

  test "an unset or empty variable keeps the default" do
    assert Config.load!(%{"GRPC_PORT" => ""}).port == 10_010
    assert Config.load!(%{"BLOK_GRPC_TLS_CERT" => "  "}).tls == nil
  end

  test "a bad HOST is refused rather than silently bound to loopback" do
    assert_raise ArgumentError, ~r/HOST must be an IP address literal/, fn ->
      Config.load!(%{"HOST" => "example.com"})
    end

    assert Config.load!(%{"HOST" => "::"}).ip == {0, 0, 0, 0, 0, 0, 0, 0}
    assert Config.load!(%{"HOST" => "::1"}).ip == {0, 0, 0, 0, 0, 0, 0, 1}
  end

  test "TLS requires a complete, readable pair", %{cert: cert, key: key} do
    assert_raise ArgumentError, ~r/BLOK_GRPC_TLS_KEY is set without/, fn ->
      Config.load!(%{"BLOK_GRPC_TLS_KEY" => key})
    end

    assert_raise ArgumentError, ~r/BLOK_GRPC_TLS_CERT is set without/, fn ->
      Config.load!(%{"BLOK_GRPC_TLS_CERT" => cert})
    end

    assert_raise ArgumentError, ~r/BLOK_GRPC_TLS_CERT must point at a readable file/, fn ->
      Config.load!(%{"BLOK_GRPC_TLS_CERT" => "/nope/server.crt", "BLOK_GRPC_TLS_KEY" => key})
    end
  end

  test "TLS and mTLS reach the adapter credentials", %{cert: cert, key: key, ca: ca} do
    tls = Config.load!(%{"BLOK_GRPC_TLS_CERT" => cert, "BLOK_GRPC_TLS_KEY" => key})
    assert tls.tls == %{cert: cert, key: key, ca: nil}
    ssl = Keyword.fetch!(Config.adapter_opts(tls), :cred).ssl
    assert ssl[:certfile] == cert
    assert ssl[:keyfile] == key
    refute Keyword.has_key?(ssl, :verify)

    mtls =
      Config.load!(%{
        "BLOK_GRPC_TLS_CERT" => cert,
        "BLOK_GRPC_TLS_KEY" => key,
        "BLOK_GRPC_TLS_CA" => ca
      })

    ssl = Keyword.fetch!(Config.adapter_opts(mtls), :cred).ssl
    assert ssl[:cacertfile] == ca
    assert ssl[:verify] == :verify_peer
    assert ssl[:fail_if_no_peer_cert] == true
  end

  test "server options carry the message ceiling, bind address and keepalive" do
    config = Config.load!(%{"BLOK_GRPC_MAX_MESSAGE_BYTES" => "2048", "HOST" => "127.0.0.1"})
    opts = Config.server_opts(config)

    assert opts[:max_body_size] == 2048
    assert opts[:port] == 10_010
    assert opts[:endpoint] == Blok.Endpoint
    adapter = opts[:adapter_opts]
    assert adapter[:ip] == {127, 0, 0, 1}
    assert adapter[:max_connections] == 256
    assert adapter[:idle_timeout] == 10_000
    assert adapter[:settings_timeout] == 5_000
    assert adapter[:inactivity_timeout] == 15_000
    refute Keyword.has_key?(adapter, :cred)
  end

  test "the running sidecar booted from this validated configuration" do
    config = Application.get_env(:blok, :config)
    assert %Config{} = config
    assert config.max_concurrency > 0
  end
end
