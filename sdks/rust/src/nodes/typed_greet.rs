use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::blok_error::BlokError;
use crate::capability_manifest::{CapabilityManifest, CapabilityResourceBounds};
use crate::node::TypedNode;
use crate::types::Context;

fn default_repeat() -> u32 {
    1
}

/// Validated input for the typed-greet demo (SPEC-B contract).
#[derive(Deserialize, JsonSchema)]
pub struct TypedGreetInput {
    pub name: String,
    #[serde(default = "default_repeat")]
    pub repeat: u32,
}

/// Typed output for the typed-greet demo.
#[derive(Serialize, JsonSchema)]
pub struct TypedGreetOutput {
    pub greeting: String,
    pub length: usize,
}

/// Typed greeting node built with the `TypedNode` contract (SPEC-B P3).
pub struct TypedGreetNode;

#[async_trait]
impl TypedNode for TypedGreetNode {
    type Input = TypedGreetInput;
    type Output = TypedGreetOutput;

    fn name(&self) -> &str {
        "typed-greet"
    }

    fn description(&self) -> &str {
        "Typed greeting (SPEC-B contract demo)"
    }

    fn capability_manifest(&self) -> Option<CapabilityManifest> {
        Some(CapabilityManifest {
            version: "1".into(),
            classification: "agent-compatible".into(),
            effects: vec![],
            capabilities: vec![],
            secrets: vec![],
            determinism: "deterministic".into(),
            idempotency: "idempotent".into(),
            maturity: "stable".into(),
            resources: Some(CapabilityResourceBounds {
                max_duration_ms: Some(5000),
                max_memory_bytes: None,
                max_input_bytes: Some(4194304),
                max_output_bytes: Some(4194304),
                max_concurrency: Some(64),
            }),
            runtimes: None,
            triggers: None,
        })
    }

    async fn run(
        &self,
        _ctx: &mut Context,
        input: TypedGreetInput,
    ) -> Result<TypedGreetOutput, BlokError> {
        let repeat = input.repeat.max(1) as usize;
        let greeting = format!("Hello, {}", input.name).repeat(repeat);
        Ok(TypedGreetOutput {
            length: greeting.len(),
            greeting,
        })
    }
}
