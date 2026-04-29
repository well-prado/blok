pub mod api_call;
pub mod blok_error_demo;
pub mod chain_test;
pub mod hello_world;
pub mod transform_data;

use crate::registry::NodeRegistry;

/// Register all example nodes with the registry.
pub fn register_all(registry: &mut NodeRegistry) {
    registry.register("hello-world", hello_world::HelloWorldNode);
    registry.register("api-call", api_call::ApiCallNode);
    registry.register("transform-data", transform_data::TransformDataNode);
    registry.register("chain-test", chain_test::ChainTestNode);
    registry.register("blok-error-demo", blok_error_demo::BlokErrorDemoNode);
}
