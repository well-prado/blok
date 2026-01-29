use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Log level for structured logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum LogLevel {
    #[serde(rename = "DEBUG")]
    Debug = 0,
    #[serde(rename = "INFO")]
    Info = 1,
    #[serde(rename = "WARN")]
    Warn = 2,
    #[serde(rename = "ERROR")]
    Error = 3,
}

/// A single log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub level: LogLevel,
    pub message: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Value>,
}

impl std::fmt::Display for LogEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let level = match self.level {
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        };
        match &self.fields {
            Some(fields) => write!(f, "[{}] {} {} {}", level, self.timestamp, self.message, fields),
            None => write!(f, "[{}] {} {}", level, self.timestamp, self.message),
        }
    }
}

/// Logger captures log entries for inclusion in ExecutionResult.logs.
///
/// Thread-safe and cheaply cloneable (uses Arc<Mutex>).
#[derive(Debug, Clone)]
pub struct Logger {
    entries: Arc<Mutex<Vec<LogEntry>>>,
    min_level: LogLevel,
}

impl Logger {
    /// Create a new logger with the specified minimum level.
    pub fn new(min_level: LogLevel) -> Self {
        Self {
            entries: Arc::new(Mutex::new(Vec::new())),
            min_level,
        }
    }

    fn log(&self, level: LogLevel, message: impl Into<String>, fields: Option<serde_json::Value>) {
        if level < self.min_level {
            return;
        }
        let entry = LogEntry {
            level,
            message: message.into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            fields,
        };
        self.entries.lock().unwrap().push(entry);
    }

    /// Log a debug message.
    pub fn debug(&self, message: impl Into<String>) {
        self.log(LogLevel::Debug, message, None);
    }

    /// Log a debug message with fields.
    pub fn debug_with(&self, message: impl Into<String>, fields: serde_json::Value) {
        self.log(LogLevel::Debug, message, Some(fields));
    }

    /// Log an info message.
    pub fn info(&self, message: impl Into<String>) {
        self.log(LogLevel::Info, message, None);
    }

    /// Log an info message with fields.
    pub fn info_with(&self, message: impl Into<String>, fields: serde_json::Value) {
        self.log(LogLevel::Info, message, Some(fields));
    }

    /// Log a warning message.
    pub fn warn(&self, message: impl Into<String>) {
        self.log(LogLevel::Warn, message, None);
    }

    /// Log a warning message with fields.
    pub fn warn_with(&self, message: impl Into<String>, fields: serde_json::Value) {
        self.log(LogLevel::Warn, message, Some(fields));
    }

    /// Log an error message.
    pub fn error(&self, message: impl Into<String>) {
        self.log(LogLevel::Error, message, None);
    }

    /// Log an error message with fields.
    pub fn error_with(&self, message: impl Into<String>, fields: serde_json::Value) {
        self.log(LogLevel::Error, message, Some(fields));
    }

    /// Get all captured log entries.
    pub fn entries(&self) -> Vec<LogEntry> {
        self.entries.lock().unwrap().clone()
    }

    /// Get log entries as formatted strings for ExecutionResult.logs.
    pub fn lines(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.to_string())
            .collect()
    }

    /// Clear all captured entries.
    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_logger_level_filtering() {
        let logger = Logger::new(LogLevel::Info);
        logger.debug("hidden");
        logger.info("visible");
        logger.warn("visible");
        logger.error("visible");

        assert_eq!(logger.entries().len(), 3);
    }

    #[test]
    fn test_logger_debug_level() {
        let logger = Logger::new(LogLevel::Debug);
        logger.debug("visible");
        assert_eq!(logger.entries().len(), 1);
    }

    #[test]
    fn test_logger_with_fields() {
        let logger = Logger::new(LogLevel::Debug);
        logger.info_with("test", serde_json::json!({"key": "value"}));

        let entries = logger.entries();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].fields.is_some());
    }

    #[test]
    fn test_logger_lines() {
        let logger = Logger::new(LogLevel::Debug);
        logger.info("hello");
        logger.error("oops");

        let lines = logger.lines();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("[INFO]"));
        assert!(lines[1].contains("[ERROR]"));
    }

    #[test]
    fn test_logger_clear() {
        let logger = Logger::new(LogLevel::Debug);
        logger.info("test");
        assert_eq!(logger.entries().len(), 1);
        logger.clear();
        assert_eq!(logger.entries().len(), 0);
    }

    #[test]
    fn test_logger_is_clone_safe() {
        let logger = Logger::new(LogLevel::Debug);
        let cloned = logger.clone();
        logger.info("from original");
        cloned.info("from clone");
        assert_eq!(logger.entries().len(), 2);
    }
}
