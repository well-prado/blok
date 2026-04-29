//! Structured `BlokError` per master plan §17 — the canonical error contract
//! every Blok node SDK populates the same way. Mirrors the TypeScript
//! `BlokError` in `core/shared/src/BlokError.ts`, the Python `BlokError` in
//! `sdks/python3/blok/errors/blok_error.py`, and the Go `BlokError` in
//! `sdks/go/blok_error.go` so node authors writing in any language see the
//! same field shape.
//!
//! # Idiomatic usage
//!
//! ```rust,no_run
//! use blok::blok_error::{BlokError, BuildContextSnapshot};
//! use std::time::Duration;
//!
//! fn connect() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
//!     Err(Box::new(
//!         BlokError::dependency()
//!             .code("POSTGRES_CONNECT_TIMEOUT")
//!             .message("Could not connect to Postgres within 5s")
//!             .description("Tried host=db.internal port=5432; timeout=5000ms")
//!             .remediation("Check DATABASE_URL env var and network reachability")
//!             .retryable(true)
//!             .retry_after(Duration::from_secs(5))
//!             .doc_url("https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT")
//!             .details(serde_json::json!({"host": "db.internal", "port": 5432}))
//!             .build()
//!     ))
//! }
//! ```
//!
//! The legacy `NodeError` in `errors.rs` (5 categories) stays available for
//! back-compat. New code should prefer `BlokError`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

// =============================================================================
// Categories — 12 values mirroring proto blok.runtime.v1.ErrorCategory
// =============================================================================

/// The 12 canonical error categories every Blok node error falls into.
///
/// Matches the proto `blok.runtime.v1.ErrorCategory` enum value-for-value, and
/// `BlokErrorCategory` is the Rust-side equivalent of the existing Go
/// `CategoryDependency`/Python `ErrorCategory.DEPENDENCY` constants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BlokErrorCategory {
    /// Input failed schema validation. Default `http_status=400`, non-retryable.
    #[serde(rename = "VALIDATION")]
    Validation,
    /// Misconfiguration of the runner / node / environment. Default 500.
    #[serde(rename = "CONFIGURATION")]
    Configuration,
    /// External dependency unreachable (DB, API). Default 502, retryable.
    #[serde(rename = "DEPENDENCY")]
    Dependency,
    /// Deadline exceeded. Default 504, retryable.
    #[serde(rename = "TIMEOUT")]
    Timeout,
    /// Caller lacks the right role/scope. Default 403.
    #[serde(rename = "PERMISSION")]
    Permission,
    /// Caller exceeded a quota. Default 429, retryable with `retry_after_ms`.
    #[serde(rename = "RATE_LIMIT")]
    RateLimit,
    /// Resource not found. Default 404.
    #[serde(rename = "NOT_FOUND")]
    NotFound,
    /// Idempotency violation, concurrent update. Default 409.
    #[serde(rename = "CONFLICT")]
    Conflict,
    /// Caller cancelled before completion. Default 499.
    #[serde(rename = "CANCELLED")]
    Cancelled,
    /// SDK threw without classification — default fallback. Default 500.
    #[serde(rename = "INTERNAL")]
    Internal,
    /// Wire-format / framing / serialization error. Default 502.
    #[serde(rename = "PROTOCOL")]
    Protocol,
    /// Payload schema OK but values are unprocessable. Default 422.
    #[serde(rename = "DATA")]
    Data,
}

impl BlokErrorCategory {
    /// String form matching the proto enum name (e.g. `"DEPENDENCY"`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Validation => "VALIDATION",
            Self::Configuration => "CONFIGURATION",
            Self::Dependency => "DEPENDENCY",
            Self::Timeout => "TIMEOUT",
            Self::Permission => "PERMISSION",
            Self::RateLimit => "RATE_LIMIT",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::Cancelled => "CANCELLED",
            Self::Internal => "INTERNAL",
            Self::Protocol => "PROTOCOL",
            Self::Data => "DATA",
        }
    }

    /// Parse a string into a category, falling back to `Internal` for unknown
    /// values (matches Python/Go behaviour).
    pub fn parse(value: &str) -> Self {
        match value {
            "VALIDATION" => Self::Validation,
            "CONFIGURATION" => Self::Configuration,
            "DEPENDENCY" => Self::Dependency,
            "TIMEOUT" => Self::Timeout,
            "PERMISSION" => Self::Permission,
            "RATE_LIMIT" => Self::RateLimit,
            "NOT_FOUND" => Self::NotFound,
            "CONFLICT" => Self::Conflict,
            "CANCELLED" => Self::Cancelled,
            "PROTOCOL" => Self::Protocol,
            "DATA" => Self::Data,
            _ => Self::Internal,
        }
    }

    /// Default HTTP status conventionally associated with this category.
    pub fn default_http_status(&self) -> i32 {
        match self {
            Self::Validation => 400,
            Self::Configuration => 500,
            Self::Dependency => 502,
            Self::Timeout => 504,
            Self::Permission => 403,
            Self::RateLimit => 429,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::Cancelled => 499,
            Self::Internal => 500,
            Self::Protocol => 502,
            Self::Data => 422,
        }
    }

    /// Default retryable hint conventionally associated with this category.
    pub fn default_retryable(&self) -> bool {
        matches!(self, Self::Dependency | Self::Timeout | Self::RateLimit)
    }
}

impl fmt::Display for BlokErrorCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// =============================================================================
// Severity — 4 values mirroring proto blok.runtime.v1.ErrorSeverity
// =============================================================================

/// How serious an error is. Default for thrown errors is `Error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BlokErrorSeverity {
    /// Informational, no action needed.
    #[serde(rename = "INFO")]
    Info,
    /// Recoverable, worth surfacing.
    #[serde(rename = "WARN")]
    Warn,
    /// Standard error level.
    #[serde(rename = "ERROR")]
    Error,
    /// Process must terminate.
    #[serde(rename = "FATAL")]
    Fatal,
}

impl BlokErrorSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
            Self::Fatal => "FATAL",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "INFO" => Self::Info,
            "WARN" => Self::Warn,
            "FATAL" => Self::Fatal,
            _ => Self::Error,
        }
    }
}

impl fmt::Display for BlokErrorSeverity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// =============================================================================
// SDK auto-enrichment defaults
// =============================================================================

/// SDK identifier reported on auto-enriched errors.
pub const DEFAULT_SDK_NAME: &str = "blok-rust";
/// Runtime kind reported on auto-enriched errors.
pub const DEFAULT_RUNTIME_KIND: &str = "runtime.rust";
/// Default cap on serialized `context_snapshot` size in bytes.
pub const CONTEXT_SNAPSHOT_MAX_BYTES: usize = 4096;

// =============================================================================
// BlokError — the structured error type
// =============================================================================

/// Canonical structured error per master plan §17.
///
/// Returned from a `NodeHandler::execute` to convey category-aware failure info
/// that flows losslessly through the gRPC wire to the runner and into Studio
/// traces.
///
/// Use [`BlokError::new`] (or the per-category factories like
/// [`BlokError::dependency`]) plus the builder methods to construct; direct
/// struct literal works too if the field-by-field form is more convenient.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlokError {
    pub category: BlokErrorCategory,
    pub severity: BlokErrorSeverity,
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub remediation: String,
    #[serde(default, alias = "docUrl")]
    pub doc_url: String,
    #[serde(alias = "httpStatus")]
    pub http_status: i32,
    pub retryable: bool,
    #[serde(default, alias = "retryAfterMs")]
    pub retry_after_ms: i64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, alias = "contextSnapshot", skip_serializing_if = "Option::is_none")]
    pub context_snapshot: Option<serde_json::Value>,

    /// Cause-chain payloads, flattened at construction time so cross-wire
    /// serialization doesn't double-count nested chains.
    #[serde(default)]
    pub causes: Vec<serde_json::Value>,
    #[serde(default)]
    pub stack: String,
    pub at: DateTime<Utc>,

    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub sdk: String,
    #[serde(default, alias = "sdkVersion")]
    pub sdk_version: String,
    #[serde(default, alias = "runtimeKind")]
    pub runtime_kind: String,
}

impl BlokError {
    /// Start a new builder for the given category. The default per-category
    /// `http_status` and `retryable` hints are applied automatically and can
    /// be overridden via the matching builder methods.
    pub fn new(category: BlokErrorCategory) -> BlokErrorBuilder {
        BlokErrorBuilder::new(category)
    }

    // --- Per-category factory shortcuts ------------------------------------

    /// Builder for a `Validation` error (default 400, non-retryable).
    pub fn validation() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Validation)
    }
    /// Builder for a `Configuration` error (default 500, non-retryable).
    pub fn configuration() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Configuration)
    }
    /// Builder for a `Dependency` error (default 502, retryable).
    pub fn dependency() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Dependency)
    }
    /// Builder for a `Timeout` error (default 504, retryable).
    pub fn timeout() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Timeout)
    }
    /// Builder for a `Permission` error (default 403, non-retryable).
    pub fn permission() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Permission)
    }
    /// Builder for a `RateLimit` error (default 429, retryable).
    pub fn rate_limit() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::RateLimit)
    }
    /// Builder for a `NotFound` error (default 404, non-retryable).
    pub fn not_found() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::NotFound)
    }
    /// Builder for a `Conflict` error (default 409, non-retryable).
    pub fn conflict() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Conflict)
    }
    /// Builder for a `Cancelled` error (default 499, non-retryable).
    pub fn cancelled() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Cancelled)
    }
    /// Builder for an `Internal` error (default 500, non-retryable).
    pub fn internal() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Internal)
    }
    /// Builder for a `Protocol` error (default 502, non-retryable).
    pub fn protocol() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Protocol)
    }
    /// Builder for a `Data` error (default 422, non-retryable).
    pub fn data() -> BlokErrorBuilder {
        Self::new(BlokErrorCategory::Data)
    }

    /// Wrap any error/value into a `BlokError`. Used by the runner's auto-wrap
    /// layer so legacy `Box::new(io::Error::...)` still produces a structured
    /// error.
    ///
    /// Categorization heuristic:
    ///
    /// * Already a `BlokError` (downcast hit) — passthrough; missing origin
    ///   fields filled in.
    /// * `&str` / `String` — becomes the message; details mirrors the message.
    /// * Anything implementing `std::error::Error` — wraps as `Internal`
    ///   with `code=UNCAUGHT_<TYPE>`, the original error preserved as the
    ///   first cause-chain entry.
    pub fn from_error(
        err: Box<dyn std::error::Error + Send + Sync>,
        origin: &Origin,
    ) -> Self {
        // First try to reclaim a typed BlokError (handler returned one wrapped
        // in `Box::new(...)`). If we get it back, just enrich origin.
        match err.downcast::<BlokError>() {
            Ok(boxed) => {
                let mut e = *boxed;
                e.apply_origin_if_missing(origin);
                e
            }
            Err(other) => Self::from_dyn_error(other.as_ref(), origin),
        }
    }

    /// Build a `BlokError` from a `&dyn std::error::Error` reference (no
    /// ownership). Useful when the registry has already consumed the boxed
    /// error or when wrapping a borrowed cause.
    pub fn from_dyn_error(err: &(dyn std::error::Error + 'static), origin: &Origin) -> Self {
        let type_name = std::any::type_name_of_val(err);
        let code = uncaught_code(type_name);
        let message = err.to_string();
        let causes = flatten_causes(err);
        let mut builder = Self::new(BlokErrorCategory::Internal)
            .code(code)
            .message(if message.is_empty() {
                "Uncaught error".to_string()
            } else {
                message
            });
        builder = builder.apply_origin(origin);
        let mut built = builder.build();
        built.causes = causes;
        built
    }

    /// Wrap an arbitrary string message as an `Internal` error.
    pub fn from_message(message: impl Into<String>, origin: &Origin) -> Self {
        let msg = message.into();
        let details = serde_json::json!({"message": msg.clone()});
        Self::new(BlokErrorCategory::Internal)
            .code("UNCAUGHT_ERROR")
            .message(msg)
            .details(details)
            .apply_origin(origin)
            .build()
    }

    /// Lossless round-trip serialization to a `serde_json::Value` matching the
    /// proto wire shape (snake_case keys).
    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::Value::Null)
    }

    /// Inverse of [`Self::to_json_value`]. Tolerant of `camelCase` keys for
    /// cross-language fixtures (uses serde aliases).
    pub fn from_json_value(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }

    /// Fill in any missing origin fields. Won't overwrite fields the handler
    /// set explicitly.
    pub fn apply_origin_if_missing(&mut self, origin: &Origin) -> &mut Self {
        if self.node.is_empty() {
            self.node = origin.node.clone();
        }
        if self.sdk.is_empty() {
            self.sdk = origin.sdk.clone();
        }
        if self.sdk_version.is_empty() {
            self.sdk_version = origin.sdk_version.clone();
        }
        if self.runtime_kind.is_empty() {
            self.runtime_kind = origin.runtime_kind.clone();
        }
        self
    }
}

impl fmt::Display for BlokError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.category, self.message)
    }
}

impl std::error::Error for BlokError {
    // The cause chain on a BlokError is already flattened into `causes`,
    // so we don't expose a `source()` — `errors.Is`/`errors.As`-equivalents
    // walk the JSON payloads instead.
}

// =============================================================================
// Builder — chained construction matching master plan §17.5
// =============================================================================

/// Fluent constructor returned by [`BlokError::new`] and the per-category
/// shortcuts. Each builder method consumes `self` and returns the builder so
/// chained calls compose without intermediate variables.
///
/// Call [`Self::build`] to finalize into a [`BlokError`] with `at`, `stack`,
/// and category defaults populated.
#[derive(Debug, Clone)]
pub struct BlokErrorBuilder {
    err: BlokError,
}

impl BlokErrorBuilder {
    fn new(category: BlokErrorCategory) -> Self {
        Self {
            err: BlokError {
                category,
                severity: BlokErrorSeverity::Error,
                code: String::new(),
                message: String::new(),
                description: String::new(),
                remediation: String::new(),
                doc_url: String::new(),
                http_status: category.default_http_status(),
                retryable: category.default_retryable(),
                retry_after_ms: 0,
                details: None,
                context_snapshot: None,
                causes: Vec::new(),
                stack: String::new(),
                at: Utc::now(),
                node: String::new(),
                sdk: String::new(),
                sdk_version: String::new(),
                runtime_kind: String::new(),
            },
        }
    }

    /// Stable machine identifier (e.g. `"POSTGRES_CONNECT_TIMEOUT"`).
    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.err.code = code.into();
        self
    }

    /// One-sentence human summary.
    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.err.message = message.into();
        self
    }

    /// Multi-paragraph context (what was tried, why it failed).
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.err.description = description.into();
        self
    }

    /// Suggested next step for the developer.
    pub fn remediation(mut self, remediation: impl Into<String>) -> Self {
        self.err.remediation = remediation.into();
        self
    }

    /// Link to documentation explaining this error code.
    pub fn doc_url(mut self, doc_url: impl Into<String>) -> Self {
        self.err.doc_url = doc_url.into();
        self
    }

    /// Override the default HTTP status for this category.
    pub fn http_status(mut self, status: i32) -> Self {
        self.err.http_status = status;
        self
    }

    /// Override the default severity (`Error`).
    pub fn severity(mut self, severity: BlokErrorSeverity) -> Self {
        self.err.severity = severity;
        self
    }

    /// Override the default retryable hint.
    pub fn retryable(mut self, retryable: bool) -> Self {
        self.err.retryable = retryable;
        self
    }

    /// Suggested retry-after duration, stored as milliseconds in the proto
    /// wire format.
    pub fn retry_after(mut self, duration: Duration) -> Self {
        self.err.retry_after_ms = duration.as_millis() as i64;
        self
    }

    /// Suggested retry-after directly in milliseconds.
    pub fn retry_after_ms(mut self, ms: i64) -> Self {
        self.err.retry_after_ms = ms;
        self
    }

    /// Category-specific structured details (Zod issues, SQL state, etc.).
    pub fn details(mut self, details: serde_json::Value) -> Self {
        self.err.details = Some(details);
        self
    }

    /// Bounded slice of inputs/state at error time. Use
    /// [`build_context_snapshot`] to construct one within the size budget.
    pub fn context_snapshot(mut self, snapshot: serde_json::Value) -> Self {
        self.err.context_snapshot = Some(snapshot);
        self
    }

    /// Attach an underlying cause. The cause chain is walked at [`Self::build`]
    /// time and flattened into the `.causes` payload list.
    pub fn cause<E: std::error::Error + 'static>(mut self, cause: &E) -> Self {
        self.err.causes = flatten_causes(cause);
        self
    }

    /// Attach an already-flattened cause-chain (e.g. when re-serializing from
    /// a wire payload).
    pub fn causes(mut self, causes: Vec<serde_json::Value>) -> Self {
        self.err.causes = causes;
        self
    }

    /// Override the auto-filled node name (handlers normally don't set this).
    pub fn node(mut self, node: impl Into<String>) -> Self {
        self.err.node = node.into();
        self
    }

    /// Override the auto-filled SDK identifier.
    pub fn sdk(mut self, sdk: impl Into<String>) -> Self {
        self.err.sdk = sdk.into();
        self
    }

    /// Override the auto-filled SDK version.
    pub fn sdk_version(mut self, version: impl Into<String>) -> Self {
        self.err.sdk_version = version.into();
        self
    }

    /// Override the auto-filled runtime kind.
    pub fn runtime_kind(mut self, kind: impl Into<String>) -> Self {
        self.err.runtime_kind = kind.into();
        self
    }

    /// Override the captured stack trace.
    pub fn stack(mut self, stack: impl Into<String>) -> Self {
        self.err.stack = stack.into();
        self
    }

    /// Apply origin fields from the runtime, only filling in unset ones.
    pub fn apply_origin(mut self, origin: &Origin) -> Self {
        self.err.apply_origin_if_missing(origin);
        self
    }

    /// Finalize into a [`BlokError`]. Re-stamps `at` with the current UTC
    /// timestamp.
    pub fn build(mut self) -> BlokError {
        self.err.at = Utc::now();
        self.err
    }
}

// =============================================================================
// Origin — auto-enrichment carrier
// =============================================================================

/// Auto-enrichment carrier the gRPC servicer fills into a handler-thrown
/// `BlokError` when the handler didn't set those fields explicitly.
#[derive(Debug, Clone)]
pub struct Origin {
    pub node: String,
    pub sdk: String,
    pub sdk_version: String,
    pub runtime_kind: String,
}

impl Origin {
    /// Build an origin with the SDK constants ([`DEFAULT_SDK_NAME`],
    /// [`DEFAULT_RUNTIME_KIND`]) and the caller-provided node name +
    /// SDK version.
    pub fn defaults(node: impl Into<String>, sdk_version: impl Into<String>) -> Self {
        Self {
            node: node.into(),
            sdk: DEFAULT_SDK_NAME.to_string(),
            sdk_version: sdk_version.into(),
            runtime_kind: DEFAULT_RUNTIME_KIND.to_string(),
        }
    }
}

// =============================================================================
// Cause-chain flattening
// =============================================================================

/// Walk an error's `source()` chain and produce a flat list of payloads.
/// Mirrors the Python/Go `flatten_causes` shape.
///
/// Cycle-safe (caps at 32 levels — pathological recursive errors don't blow
/// the stack). When a `BlokError` is encountered in the chain, its already-
/// flattened causes are appended without nesting.
pub fn flatten_causes(cause: &(dyn std::error::Error + 'static)) -> Vec<serde_json::Value> {
    let mut causes: Vec<serde_json::Value> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(cause);
    let mut depth = 0usize;
    while let Some(err) = current {
        if depth >= 32 {
            break;
        }
        depth += 1;
        // BlokError chains are already flat; lift each link in directly.
        if let Some(blok) = err.downcast_ref::<BlokError>() {
            let mut payload = blok.to_json_value();
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("causes".to_string(), serde_json::json!([]));
            }
            causes.push(payload);
            for nested in &blok.causes {
                causes.push(nested.clone());
            }
            return causes;
        }
        causes.push(err_to_payload(err));
        current = err.source();
    }
    causes
}

fn err_to_payload(err: &(dyn std::error::Error + 'static)) -> serde_json::Value {
    let type_name = std::any::type_name_of_val(err);
    serde_json::json!({
        "code": uncaught_code(type_name),
        "category": BlokErrorCategory::Internal.as_str(),
        "severity": BlokErrorSeverity::Error.as_str(),
        "node": "",
        "sdk": "",
        "sdk_version": "",
        "runtime_kind": "",
        "at": Utc::now().to_rfc3339(),
        "message": err.to_string(),
        "description": "",
        "remediation": "",
        "doc_url": "",
        "causes": [],
        "stack": "",
        "context_snapshot": serde_json::Value::Null,
        "http_status": 500,
        "retryable": false,
        "retry_after_ms": 0,
        "details": serde_json::Value::Null,
    })
}

/// Derive an `UNCAUGHT_<TYPE>` code from a Rust type name.
///
/// Strips module path qualifiers and uppercases the simple type name, matching
/// the Python `UNCAUGHT_CONNECTIONERROR` and Go `UNCAUGHT_<TYPE>` conventions.
/// Returns `"UNCAUGHT_ERROR"` if the input has no useful identifier characters.
fn uncaught_code(type_name: &str) -> String {
    // Trim generics: "alloc::boxed::Box<core::error::Error>" → "alloc::boxed::Box"
    let without_generics = match type_name.find('<') {
        Some(i) => &type_name[..i],
        None => type_name,
    };
    // Strip module path: "std::io::Error" → "Error"
    let simple = match without_generics.rfind("::") {
        Some(i) => &without_generics[i + 2..],
        None => without_generics,
    };
    let upper: String = simple
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if upper.is_empty() {
        "UNCAUGHT_ERROR".to_string()
    } else {
        format!("UNCAUGHT_{}", upper)
    }
}

// =============================================================================
// BuildContextSnapshot helper
// =============================================================================

/// Marker re-export used in module docs so doctests compile under all features.
pub use self::build_context_snapshot as BuildContextSnapshot;

/// Build a JSON-friendly bounded slice of inputs + recent vars for the
/// `context_snapshot` field. Per master plan §17.6: 4KB cap by default + last
/// 16 vars keys, with progressive trimming when oversize. `inputs` is preserved
/// as-is — it's the most LLM-actionable context.
pub fn build_context_snapshot(
    inputs: &std::collections::HashMap<String, serde_json::Value>,
    vars: &std::collections::HashMap<String, serde_json::Value>,
) -> serde_json::Value {
    build_context_snapshot_with_opts(inputs, vars, CONTEXT_SNAPSHOT_MAX_BYTES, 16)
}

/// Customizable variant of [`build_context_snapshot`].
///
/// `max_vars_keys=0` drops vars entirely; `max_bytes=0` disables byte-budget
/// trimming.
pub fn build_context_snapshot_with_opts(
    inputs: &std::collections::HashMap<String, serde_json::Value>,
    vars: &std::collections::HashMap<String, serde_json::Value>,
    max_bytes: usize,
    max_vars_keys: usize,
) -> serde_json::Value {
    let safe_inputs = json_safe_map(inputs);

    // Use BTreeMap so the keys are sorted — gives a deterministic "last N" slice
    // (Rust HashMap iteration order is randomized; LLM/Studio consumers don't
    // care about the order, but tests do).
    let sorted: BTreeMap<&String, &serde_json::Value> = vars.iter().collect();
    let mut keys: Vec<String> = sorted.keys().map(|k| (*k).clone()).collect();
    if keys.len() > max_vars_keys {
        let drop = keys.len() - max_vars_keys;
        keys.drain(..drop);
    }

    let mut recent: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    for k in &keys {
        if let Some(v) = vars.get(k) {
            recent.insert(k.clone(), json_safe(v));
        }
    }

    let mut snapshot = serde_json::json!({
        "inputs": safe_inputs,
        "vars": serde_json::Value::Object(recent.clone()),
    });

    if max_bytes == 0 {
        return snapshot;
    }

    let encoded = serde_json::to_vec(&snapshot).unwrap_or_default();
    if encoded.len() <= max_bytes {
        return snapshot;
    }

    // Trim from the front (oldest keys) until it fits.
    let mut working = keys.clone();
    while !working.is_empty() {
        working.remove(0);
        recent = serde_json::Map::new();
        for k in &working {
            if let Some(v) = vars.get(k) {
                recent.insert(k.clone(), json_safe(v));
            }
        }
        snapshot["vars"] = serde_json::Value::Object(recent.clone());
        let encoded = serde_json::to_vec(&snapshot).unwrap_or_default();
        if encoded.len() <= max_bytes {
            return snapshot;
        }
    }

    serde_json::json!({
        "inputs": safe_inputs,
        "vars": {},
        "_truncated": true,
    })
}

fn json_safe_map(
    m: &std::collections::HashMap<String, serde_json::Value>,
) -> serde_json::Value {
    let mut out = serde_json::Map::with_capacity(m.len());
    for (k, v) in m {
        out.insert(k.clone(), json_safe(v));
    }
    serde_json::Value::Object(out)
}

fn json_safe(v: &serde_json::Value) -> serde_json::Value {
    // serde_json::Value is already JSON-safe by construction; this is a deep
    // clone with a hook for the future when richer types might flow through.
    v.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn category_default_status_matches_table() {
        assert_eq!(BlokErrorCategory::Validation.default_http_status(), 400);
        assert_eq!(BlokErrorCategory::Configuration.default_http_status(), 500);
        assert_eq!(BlokErrorCategory::Dependency.default_http_status(), 502);
        assert_eq!(BlokErrorCategory::Timeout.default_http_status(), 504);
        assert_eq!(BlokErrorCategory::Permission.default_http_status(), 403);
        assert_eq!(BlokErrorCategory::RateLimit.default_http_status(), 429);
        assert_eq!(BlokErrorCategory::NotFound.default_http_status(), 404);
        assert_eq!(BlokErrorCategory::Conflict.default_http_status(), 409);
        assert_eq!(BlokErrorCategory::Cancelled.default_http_status(), 499);
        assert_eq!(BlokErrorCategory::Internal.default_http_status(), 500);
        assert_eq!(BlokErrorCategory::Protocol.default_http_status(), 502);
        assert_eq!(BlokErrorCategory::Data.default_http_status(), 422);
    }

    #[test]
    fn category_default_retryable_matches_table() {
        assert!(BlokErrorCategory::Dependency.default_retryable());
        assert!(BlokErrorCategory::Timeout.default_retryable());
        assert!(BlokErrorCategory::RateLimit.default_retryable());
        assert!(!BlokErrorCategory::Validation.default_retryable());
        assert!(!BlokErrorCategory::Internal.default_retryable());
    }

    #[test]
    fn category_parse_unknown_falls_back_to_internal() {
        assert_eq!(BlokErrorCategory::parse("DEPENDENCY"), BlokErrorCategory::Dependency);
        assert_eq!(BlokErrorCategory::parse("not-a-thing"), BlokErrorCategory::Internal);
    }

    #[test]
    fn severity_parse_falls_back_to_error() {
        assert_eq!(BlokErrorSeverity::parse("INFO"), BlokErrorSeverity::Info);
        assert_eq!(BlokErrorSeverity::parse("xyz"), BlokErrorSeverity::Error);
    }

    #[test]
    fn builder_dependency_defaults() {
        let e = BlokError::dependency().code("X").message("y").build();
        assert_eq!(e.category, BlokErrorCategory::Dependency);
        assert_eq!(e.http_status, 502);
        assert!(e.retryable);
        assert_eq!(e.severity, BlokErrorSeverity::Error);
    }

    #[test]
    fn builder_validation_defaults() {
        let e = BlokError::validation().code("V").message("v").build();
        assert_eq!(e.category, BlokErrorCategory::Validation);
        assert_eq!(e.http_status, 400);
        assert!(!e.retryable);
    }

    #[test]
    fn builder_overrides_take_priority() {
        let e = BlokError::dependency()
            .http_status(599)
            .retryable(false)
            .severity(BlokErrorSeverity::Fatal)
            .build();
        assert_eq!(e.http_status, 599);
        assert!(!e.retryable);
        assert_eq!(e.severity, BlokErrorSeverity::Fatal);
    }

    #[test]
    fn builder_retry_after_duration_into_ms() {
        let e = BlokError::rate_limit()
            .retry_after(Duration::from_secs(5))
            .build();
        assert_eq!(e.retry_after_ms, 5_000);
    }

    #[test]
    fn builder_retry_after_ms_direct() {
        let e = BlokError::timeout().retry_after_ms(750).build();
        assert_eq!(e.retry_after_ms, 750);
    }

    #[test]
    fn builder_details_round_trip() {
        let e = BlokError::validation()
            .details(serde_json::json!({"issues": [{"path": ["email"]}]}))
            .build();
        let det = e.details.as_ref().unwrap();
        assert_eq!(det["issues"][0]["path"][0], "email");
    }

    #[test]
    fn builder_attaches_cause_via_flatten() {
        let cause = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "nope");
        let e = BlokError::dependency().cause(&cause).build();
        assert!(!e.causes.is_empty());
        assert_eq!(e.causes[0]["category"], "INTERNAL");
        assert_eq!(e.causes[0]["message"], "nope");
    }

    #[test]
    fn builder_apply_origin_fills_only_missing() {
        let origin = Origin::defaults("my-node", "1.2.3");
        let e = BlokError::dependency().sdk("custom").apply_origin(&origin).build();
        assert_eq!(e.sdk, "custom"); // explicit value preserved
        assert_eq!(e.node, "my-node"); // empty filled
        assert_eq!(e.sdk_version, "1.2.3");
        assert_eq!(e.runtime_kind, "runtime.rust");
    }

    #[test]
    fn from_message_creates_internal_error() {
        let origin = Origin::defaults("x", "1.0.0");
        let e = BlokError::from_message("boom", &origin);
        assert_eq!(e.category, BlokErrorCategory::Internal);
        assert_eq!(e.code, "UNCAUGHT_ERROR");
        assert_eq!(e.message, "boom");
        assert_eq!(e.details.unwrap()["message"], "boom");
    }

    #[test]
    fn from_dyn_error_categorizes_as_internal() {
        let cause = std::io::Error::new(std::io::ErrorKind::TimedOut, "slow");
        let origin = Origin::defaults("x", "1.0.0");
        let e = BlokError::from_dyn_error(&cause, &origin);
        assert_eq!(e.category, BlokErrorCategory::Internal);
        assert!(e.code.starts_with("UNCAUGHT_"));
        assert_eq!(e.message, "slow");
        assert_eq!(e.node, "x");
    }

    #[test]
    fn from_error_passes_through_typed_blok_error() {
        let origin = Origin::defaults("auto-node", "1.2.3");
        let original = BlokError::rate_limit()
            .code("UPSTREAM_RATE_LIMITED")
            .message("limit hit")
            .build();
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(original);
        let recovered = BlokError::from_error(boxed, &origin);
        assert_eq!(recovered.category, BlokErrorCategory::RateLimit);
        assert_eq!(recovered.code, "UPSTREAM_RATE_LIMITED");
        // Origin auto-enrichment kicked in.
        assert_eq!(recovered.node, "auto-node");
        assert_eq!(recovered.sdk_version, "1.2.3");
    }

    #[test]
    fn from_error_wraps_non_blok_error() {
        let origin = Origin::defaults("auto", "1.0.0");
        let cause = std::io::Error::other("disk full");
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(cause);
        let wrapped = BlokError::from_error(boxed, &origin);
        assert_eq!(wrapped.category, BlokErrorCategory::Internal);
        assert_eq!(wrapped.message, "disk full");
        assert!(wrapped.code.starts_with("UNCAUGHT_"));
    }

    #[test]
    fn to_json_value_round_trip() {
        let e = BlokError::dependency()
            .code("CODE")
            .message("msg")
            .description("desc")
            .remediation("rem")
            .retryable(true)
            .retry_after_ms(1234)
            .doc_url("https://example.com")
            .details(serde_json::json!({"a": 1}))
            .context_snapshot(serde_json::json!({"inputs": {}}))
            .node("n")
            .sdk("blok-rust")
            .sdk_version("1.0.0")
            .runtime_kind("runtime.rust")
            .build();

        let v = e.to_json_value();
        assert_eq!(v["category"], "DEPENDENCY");
        assert_eq!(v["code"], "CODE");
        assert_eq!(v["http_status"], 502);
        assert_eq!(v["retry_after_ms"], 1234);

        let restored = BlokError::from_json_value(v).unwrap();
        assert_eq!(restored.category, BlokErrorCategory::Dependency);
        assert_eq!(restored.code, "CODE");
        assert_eq!(restored.message, "msg");
        assert_eq!(restored.description, "desc");
        assert_eq!(restored.retry_after_ms, 1234);
    }

    #[test]
    fn from_json_value_accepts_camel_case() {
        let v = serde_json::json!({
            "category": "RATE_LIMIT",
            "severity": "ERROR",
            "code": "RL",
            "message": "too many",
            "httpStatus": 429,
            "retryable": true,
            "retryAfterMs": 60000,
            "at": "2026-04-29T00:00:00Z",
            "sdkVersion": "1.0.0",
            "runtimeKind": "runtime.rust",
            "docUrl": "https://docs/example"
        });
        let e = BlokError::from_json_value(v).unwrap();
        assert_eq!(e.category, BlokErrorCategory::RateLimit);
        assert_eq!(e.http_status, 429);
        assert_eq!(e.retry_after_ms, 60_000);
        assert_eq!(e.sdk_version, "1.0.0");
        assert_eq!(e.runtime_kind, "runtime.rust");
        assert_eq!(e.doc_url, "https://docs/example");
    }

    #[test]
    fn display_formats_category_and_message() {
        let e = BlokError::dependency().code("X").message("nope").build();
        assert_eq!(e.to_string(), "[DEPENDENCY] nope");
    }

    #[test]
    fn impls_std_error_trait() {
        fn assert_send_sync<T: std::error::Error + Send + Sync + 'static>() {}
        assert_send_sync::<BlokError>();
    }

    #[test]
    fn flatten_causes_walks_source_chain() {
        // Build a tiny custom error that exposes a source.
        #[derive(Debug)]
        struct Wrap(std::io::Error);
        impl fmt::Display for Wrap {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "wrapped")
            }
        }
        impl std::error::Error for Wrap {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let inner = std::io::Error::new(std::io::ErrorKind::Other, "inner");
        let wrap = Wrap(inner);
        let causes = flatten_causes(&wrap);
        assert_eq!(causes.len(), 2);
        assert_eq!(causes[0]["message"], "wrapped");
        assert_eq!(causes[1]["message"], "inner");
    }

    #[test]
    fn flatten_causes_lifts_blok_error_link() {
        let inner_blok = BlokError::not_found()
            .code("INNER")
            .message("inner-msg")
            .build();
        // Sanity: lifting occurs when the chain root is a BlokError directly.
        let causes = flatten_causes(&inner_blok);
        assert_eq!(causes[0]["code"], "INNER");
        assert_eq!(causes[0]["category"], "NOT_FOUND");
    }

    #[test]
    fn build_context_snapshot_preserves_small_payload() {
        let mut inputs = HashMap::new();
        inputs.insert("a".to_string(), serde_json::json!(1));
        let mut vars = HashMap::new();
        vars.insert("k1".to_string(), serde_json::json!("v1"));
        let snap = build_context_snapshot(&inputs, &vars);
        assert_eq!(snap["inputs"]["a"], 1);
        assert_eq!(snap["vars"]["k1"], "v1");
    }

    #[test]
    fn build_context_snapshot_caps_at_max_bytes() {
        let inputs = HashMap::new();
        let mut vars = HashMap::new();
        // 80 keys with 100-char values each — well over 4KB combined.
        for i in 0..80u32 {
            vars.insert(format!("k{:03}", i), serde_json::json!("x".repeat(100)));
        }
        let snap = build_context_snapshot(&inputs, &vars);
        let encoded = serde_json::to_vec(&snap).unwrap();
        assert!(
            encoded.len() <= CONTEXT_SNAPSHOT_MAX_BYTES + 64, // small fudge for trailing whitespace
            "snapshot ({} bytes) exceeded budget {}",
            encoded.len(),
            CONTEXT_SNAPSHOT_MAX_BYTES
        );
    }

    #[test]
    fn build_context_snapshot_keeps_last_n_keys() {
        let inputs = HashMap::new();
        let mut vars = HashMap::new();
        for i in 0..32u32 {
            vars.insert(format!("k{:02}", i), serde_json::json!(i));
        }
        let snap = build_context_snapshot_with_opts(&inputs, &vars, 0, 5);
        let kept = snap["vars"].as_object().unwrap();
        assert_eq!(kept.len(), 5);
        // Sorted insertion → "last 5" of "k00..k31" = k27..k31.
        assert!(kept.contains_key("k31"));
        assert!(!kept.contains_key("k00"));
    }

    #[test]
    fn build_context_snapshot_disables_var_keys_when_zero() {
        let inputs = HashMap::new();
        let mut vars = HashMap::new();
        vars.insert("only".to_string(), serde_json::json!(1));
        let snap = build_context_snapshot_with_opts(&inputs, &vars, 0, 0);
        assert!(snap["vars"].as_object().unwrap().is_empty());
    }

    #[test]
    fn uncaught_code_strips_module_path() {
        assert_eq!(uncaught_code("std::io::Error"), "UNCAUGHT_ERROR");
        assert_eq!(uncaught_code("ConnectionError"), "UNCAUGHT_CONNECTIONERROR");
        assert_eq!(uncaught_code(""), "UNCAUGHT_ERROR");
        assert_eq!(uncaught_code("foo::Bar<Baz>"), "UNCAUGHT_BAR");
    }

    #[test]
    fn origin_defaults_uses_sdk_constants() {
        let o = Origin::defaults("n", "1.2.3");
        assert_eq!(o.sdk, DEFAULT_SDK_NAME);
        assert_eq!(o.runtime_kind, DEFAULT_RUNTIME_KIND);
        assert_eq!(o.node, "n");
        assert_eq!(o.sdk_version, "1.2.3");
    }

    #[test]
    fn apply_origin_if_missing_preserves_explicit_fields() {
        let mut e = BlokError::internal().node("explicit").build();
        let origin = Origin::defaults("auto", "1.0.0");
        e.apply_origin_if_missing(&origin);
        assert_eq!(e.node, "explicit");
        assert_eq!(e.sdk, DEFAULT_SDK_NAME);
        assert_eq!(e.runtime_kind, DEFAULT_RUNTIME_KIND);
    }
}
