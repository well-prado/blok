import Config

config :blok,
  host: "0.0.0.0",
  port: 10010,
  max_message_bytes: 16 * 1024 * 1024,
  max_concurrency: 16,
  max_queue: 64,
  cancellation_grace_ms: 250,
  nodes: [Blok.Examples.HelloWorld]

import_config "nodes.exs"
