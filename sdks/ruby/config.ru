# frozen_string_literal: true

require_relative "lib/blok"
require_relative "examples/hello_world_node"
require_relative "examples/api_call_node"
require_relative "examples/transform_data_node"
require_relative "examples/chain_test_node"

registry = Blok::Server::RuntimeApp.registry
registry.register("hello-world", HelloWorldNode.new)
registry.register("api-call", ApiCallNode.new)
registry.register("transform-data", TransformDataNode.new)
registry.register("chain-test", ChainTestNode.new)

run Blok::Server::RuntimeApp
