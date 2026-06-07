//! Tests for the typed `TypedNode` contract (SPEC-B P3).

use async_trait::async_trait;
use blok::{BlokError, Context, NodeHandler, NodeRegistry, TypedNode, TypedNodeHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn ten() -> u32 {
    10
}

#[derive(Deserialize, JsonSchema)]
struct Input {
    query: String,
    #[serde(default = "ten")]
    limit: u32,
}

#[derive(Serialize, JsonSchema)]
struct Output {
    results: Vec<String>,
    count: usize,
}

struct Search;

#[async_trait]
impl TypedNode for Search {
    type Input = Input;
    type Output = Output;
    fn name(&self) -> &str {
        "@acme/search"
    }
    fn description(&self) -> &str {
        "Full-text search"
    }
    async fn run(&self, _ctx: &mut Context, input: Input) -> Result<Output, BlokError> {
        let results = vec![input.query; input.limit as usize];
        Ok(Output {
            count: results.len(),
            results,
        })
    }
}

fn ctx() -> Context {
    serde_json::from_value(serde_json::json!({ "id": "t", "request": {} })).expect("ctx")
}

fn cfg(v: serde_json::Value) -> HashMap<String, serde_json::Value> {
    v.as_object().expect("object").clone().into_iter().collect()
}

#[tokio::test]
async fn validates_input_and_serializes_output() {
    let h = TypedNodeHandler(Search);
    let out = h
        .execute(&mut ctx(), &cfg(serde_json::json!({ "query": "ada", "limit": 2 })))
        .await
        .expect("ok");
    assert_eq!(out, serde_json::json!({ "results": ["ada", "ada"], "count": 2 }));
}

#[tokio::test]
async fn applies_serde_defaults() {
    let h = TypedNodeHandler(Search);
    let out = h
        .execute(&mut ctx(), &cfg(serde_json::json!({ "query": "x" })))
        .await
        .expect("ok");
    assert_eq!(out["count"], serde_json::json!(10));
}

#[tokio::test]
async fn invalid_input_yields_validation_error() {
    let h = TypedNodeHandler(Search);
    // `query` is required → deserialization fails → structured BlokError.
    let err = h
        .execute(&mut ctx(), &cfg(serde_json::json!({ "limit": 5 })))
        .await
        .expect_err("should fail");
    let msg = err.to_string();
    assert!(msg.contains("query") || msg.contains("Input validation failed"), "got: {msg}");
}

#[test]
fn reflection_schemas_and_description() {
    let h = TypedNodeHandler(Search);
    let input = h.input_schema().expect("input schema");
    assert!(input.to_string().contains("query"));
    let output = h.output_schema().expect("output schema");
    assert!(output.to_string().contains("count"));
    assert_eq!(h.description(), "Full-text search");
}

#[test]
fn register_typed_registers_under_name() {
    let mut reg = NodeRegistry::new("1.0.0-test");
    reg.register_typed(Search);
    let handler = reg.get("@acme/search").expect("registered");
    assert_eq!(handler.description(), "Full-text search");
    assert!(handler.input_schema().is_some());
}
