use serde::{Deserialize, Serialize};

/// Language-neutral v1 operational metadata from ADR 0003.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityManifest {
    pub version: String,
    pub classification: String,
    pub effects: Vec<String>,
    pub capabilities: Vec<String>,
    pub secrets: Vec<String>,
    pub determinism: String,
    pub idempotency: String,
    pub maturity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<CapabilityResourceBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtimes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResourceBounds {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_input_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<u64>,
}
