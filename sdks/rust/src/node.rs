use async_trait::async_trait;
use std::collections::HashMap;

use crate::blok_error::BlokError;
use crate::types::Context;

/// NodeHandler is the core trait that all Blok nodes must implement.
///
/// # Example
///
/// ```rust
/// use async_trait::async_trait;
/// use blok::{NodeHandler, Context};
/// use std::collections::HashMap;
///
/// struct MyNode;
///
/// #[async_trait]
/// impl NodeHandler for MyNode {
///     async fn execute(
///         &self,
///         ctx: &mut Context,
///         config: &HashMap<String, serde_json::Value>,
///     ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
///         let name = ctx.request.body_str("name").unwrap_or("World");
///         Ok(serde_json::json!({ "message": format!("Hello, {}!", name) }))
///     }
/// }
/// ```
#[async_trait]
pub trait NodeHandler: Send + Sync {
    /// Execute the node logic with the given workflow context and node configuration.
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>>;

    /// v0.7 — human-readable description, surfaced in the node catalog
    /// (`GET /__blok/nodes`). Default empty; `TypedNode` overrides it.
    fn description(&self) -> &str {
        ""
    }

    /// v0.7 — JSON Schema for this node's input, for the catalog / gRPC
    /// `ListNodes` reflection (SPEC-B P3). Default `None`; the typed contract
    /// (`TypedNode`) returns the derived schema.
    fn input_schema(&self) -> Option<serde_json::Value> {
        None
    }

    /// v0.7 — JSON Schema for this node's output. See [`Self::input_schema`].
    fn output_schema(&self) -> Option<serde_json::Value> {
        None
    }
}

/// ValidatedNodeHandler extends NodeHandler with input/output schema support.
#[async_trait]
pub trait ValidatedNodeHandler: NodeHandler {
    /// Return the JSON Schema for validating input (request body).
    /// Return None to skip input validation.
    fn input_schema(&self) -> Option<serde_json::Value> {
        None
    }

    /// Return the JSON Schema for validating output (result data).
    /// Return None to skip output validation.
    fn output_schema(&self) -> Option<serde_json::Value> {
        None
    }
}

/// `TypedNode` — the typed authoring contract (SPEC-B P3), the Rust equivalent of
/// the TypeScript `defineNode` / Python `@node`. Declare typed `Input`/`Output`
/// (deriving `serde` + `schemars::JsonSchema`); the SDK validates `config ->
/// Input` BEFORE `run`, serializes the `Output`, and reflects both JSON Schemas
/// via gRPC `ListNodes` — instead of a raw `HashMap<String, serde_json::Value>`.
///
/// Register with `NodeRegistry::register_typed`, or wrap with
/// [`TypedNodeHandler`] and register as a normal `NodeHandler`.
///
/// ```ignore
/// #[derive(serde::Deserialize, schemars::JsonSchema)]
/// struct Input { query: String, #[serde(default)] limit: u32 }
/// #[derive(serde::Serialize, schemars::JsonSchema)]
/// struct Output { results: Vec<String>, count: usize }
///
/// struct Search;
/// #[async_trait::async_trait]
/// impl blok::TypedNode for Search {
///     type Input = Input;
///     type Output = Output;
///     fn name(&self) -> &str { "@acme/search" }
///     fn description(&self) -> &str { "Full-text search" }
///     async fn run(&self, _ctx: &mut blok::Context, input: Input) -> Result<Output, blok::BlokError> {
///         let results = vec![input.query];
///         Ok(Output { count: results.len(), results })
///     }
/// }
/// ```
#[async_trait]
pub trait TypedNode: Send + Sync {
    /// Validated, typed input — `serde::Deserialize` + `schemars::JsonSchema`.
    type Input: serde::de::DeserializeOwned + schemars::JsonSchema + Send;
    /// Typed output — `serde::Serialize` + `schemars::JsonSchema`.
    type Output: serde::Serialize + schemars::JsonSchema + Send;

    /// The node's registered name (e.g. `"@acme/search"`).
    fn name(&self) -> &str;

    /// Human-readable description (surfaced in the node catalog).
    fn description(&self) -> &str {
        ""
    }

    /// Run the node with a VALIDATED, typed input.
    async fn run(&self, ctx: &mut Context, input: Self::Input) -> Result<Self::Output, BlokError>;
}

/// Adapts a [`TypedNode`] into a [`NodeHandler`]: deserializes `config -> Input`
/// (a failure becomes a structured `BlokError`, HTTP 400), runs it, serializes
/// the `Output`, and exposes both JSON Schemas. A distinct concrete type, so it
/// never conflicts with hand-written `impl NodeHandler for …` blocks.
pub struct TypedNodeHandler<T: TypedNode>(pub T);

#[async_trait]
impl<T: TypedNode> NodeHandler for TypedNodeHandler<T> {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let value = serde_json::to_value(config)
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

        let input: T::Input = serde_json::from_value(value).map_err(|e| {
            Box::new(
                BlokError::validation()
                    .code("NODE_INPUT_VALIDATION")
                    .message(format!(
                        "Input validation failed for node '{}': {}",
                        self.0.name(),
                        e
                    ))
                    .http_status(400)
                    .node(self.0.name())
                    .build(),
            ) as Box<dyn std::error::Error + Send + Sync>
        })?;

        let output = self
            .0
            .run(ctx, input)
            .await
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

        serde_json::to_value(output).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
    }

    fn description(&self) -> &str {
        self.0.description()
    }

    fn input_schema(&self) -> Option<serde_json::Value> {
        serde_json::to_value(schemars::schema_for!(T::Input)).ok()
    }

    fn output_schema(&self) -> Option<serde_json::Value> {
        serde_json::to_value(schemars::schema_for!(T::Output)).ok()
    }
}
