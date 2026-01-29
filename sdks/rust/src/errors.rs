use serde::{Deserialize, Serialize};
use thiserror::Error;

/// ErrorCategory classifies the type of error that occurred.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ErrorCategory {
    #[serde(rename = "VALIDATION")]
    Validation,
    #[serde(rename = "EXECUTION")]
    Execution,
    #[serde(rename = "CONFIGURATION")]
    Configuration,
    #[serde(rename = "NETWORK")]
    Network,
    #[serde(rename = "NOT_FOUND")]
    NotFound,
}

impl std::fmt::Display for ErrorCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation => write!(f, "VALIDATION"),
            Self::Execution => write!(f, "EXECUTION"),
            Self::Configuration => write!(f, "CONFIGURATION"),
            Self::Network => write!(f, "NETWORK"),
            Self::NotFound => write!(f, "NOT_FOUND"),
        }
    }
}

/// NodeError represents a structured error from node execution.
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
#[error("[{category}] {message}")]
pub struct NodeError {
    pub message: String,
    pub code: u16,
    pub category: ErrorCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl NodeError {
    /// Create a validation error (400).
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 400,
            category: ErrorCategory::Validation,
            details: None,
        }
    }

    /// Create an execution error (500).
    pub fn execution(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 500,
            category: ErrorCategory::Execution,
            details: None,
        }
    }

    /// Create a configuration error (500).
    pub fn configuration(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 500,
            category: ErrorCategory::Configuration,
            details: None,
        }
    }

    /// Create a network error (502).
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 502,
            category: ErrorCategory::Network,
            details: None,
        }
    }

    /// Create a not-found error (404).
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 404,
            category: ErrorCategory::NotFound,
            details: None,
        }
    }

    /// Attach details to the error.
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Convert to a JSON value for ExecutionResult.errors.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "message": self.message,
            "code": self.code,
            "category": self.category,
            "details": self.details,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = NodeError::validation("bad input");
        assert_eq!(err.to_string(), "[VALIDATION] bad input");
    }

    #[test]
    fn test_error_factories() {
        assert_eq!(NodeError::validation("x").code, 400);
        assert_eq!(NodeError::execution("x").code, 500);
        assert_eq!(NodeError::configuration("x").code, 500);
        assert_eq!(NodeError::network("x").code, 502);
        assert_eq!(NodeError::not_found("x").code, 404);
    }

    #[test]
    fn test_error_with_details() {
        let err = NodeError::validation("bad").with_details(serde_json::json!({"field": "name"}));
        assert!(err.details.is_some());
    }

    #[test]
    fn test_error_to_json() {
        let err = NodeError::validation("invalid input");
        let json = err.to_json();
        assert_eq!(json["message"], "invalid input");
        assert_eq!(json["code"], 400);
    }
}
