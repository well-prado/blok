from examples.hello_world_node import HelloWorldNode
from examples.chain_test_node import ChainTestNode
from examples.api_call_node import ApiCallNode
from examples.transform_data_node import TransformDataNode

HELLO_WORLD_NODE_NAME = "hello-world"
API_CALL_NODE_NAME = "api-call"
TRANSFORM_DATA_NODE_NAME = "transform-data"
CHAIN_TEST_NODE_NAME = "chain-test"


def register_all(registry):
    """Register all example nodes with the registry."""
    registry.register(HELLO_WORLD_NODE_NAME, HelloWorldNode())
    registry.register(API_CALL_NODE_NAME, ApiCallNode())
    registry.register(TRANSFORM_DATA_NODE_NAME, TransformDataNode())
    registry.register(CHAIN_TEST_NODE_NAME, ChainTestNode())
