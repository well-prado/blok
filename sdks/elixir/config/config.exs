import Config

# Runtime knobs live in `Blok.Config`, which reads and validates the process
# environment at boot. Only the compile-time node registry belongs here.
config :blok,
  nodes: [Blok.Examples.HelloWorld, Blok.Examples.TypedGreet, Blok.Examples.ChainTest]

import_config "nodes.exs"

# Failure-mode fixtures from test/support. Declared last so the generated
# registry above cannot drop them.
if config_env() == :test do
  config :blok,
    nodes: [
      Blok.Examples.HelloWorld,
      Blok.Examples.TypedGreet,
      Blok.Examples.ChainTest,
      Blok.TestNodes.Boom,
      Blok.TestNodes.Throw,
      Blok.TestNodes.Exit,
      Blok.TestNodes.Sleep,
      Blok.TestNodes.SpawnChild
    ]
end
