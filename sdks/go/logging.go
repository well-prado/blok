package blok

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// LogLevel represents the severity of a log entry.
type LogLevel string

const (
	LogLevelDebug LogLevel = "DEBUG"
	LogLevelInfo  LogLevel = "INFO"
	LogLevelWarn  LogLevel = "WARN"
	LogLevelError LogLevel = "ERROR"
)

var logLevelPriority = map[LogLevel]int{
	LogLevelDebug: 0,
	LogLevelInfo:  1,
	LogLevelWarn:  2,
	LogLevelError: 3,
}

// LogEntry represents a single log entry.
type LogEntry struct {
	Level     LogLevel               `json:"level"`
	Message   string                 `json:"message"`
	Timestamp time.Time              `json:"timestamp"`
	Fields    map[string]interface{} `json:"fields,omitempty"`
}

// String returns the log entry as a formatted string.
func (e *LogEntry) String() string {
	ts := e.Timestamp.Format(time.RFC3339Nano)
	if len(e.Fields) > 0 {
		fieldsJSON, _ := json.Marshal(e.Fields)
		return fmt.Sprintf("[%s] %s %s %s", e.Level, ts, e.Message, string(fieldsJSON))
	}
	return fmt.Sprintf("[%s] %s %s", e.Level, ts, e.Message)
}

// Logger provides structured logging with a capture buffer.
// Log entries are captured and returned in ExecutionResult.logs.
type Logger struct {
	mu       sync.Mutex
	entries  []LogEntry
	minLevel LogLevel
}

// NewLogger creates a new logger with the specified minimum log level.
func NewLogger(minLevel LogLevel) *Logger {
	return &Logger{
		entries:  make([]LogEntry, 0),
		minLevel: minLevel,
	}
}

// shouldLog returns true if the level meets the minimum threshold.
func (l *Logger) shouldLog(level LogLevel) bool {
	return logLevelPriority[level] >= logLevelPriority[l.minLevel]
}

// log adds a log entry if the level meets the threshold.
func (l *Logger) log(level LogLevel, message string, fields map[string]interface{}) {
	if !l.shouldLog(level) {
		return
	}

	entry := LogEntry{
		Level:     level,
		Message:   message,
		Timestamp: time.Now(),
		Fields:    fields,
	}

	l.mu.Lock()
	l.entries = append(l.entries, entry)
	l.mu.Unlock()
}

// Debug logs a debug-level message.
func (l *Logger) Debug(message string, fields ...map[string]interface{}) {
	var f map[string]interface{}
	if len(fields) > 0 {
		f = fields[0]
	}
	l.log(LogLevelDebug, message, f)
}

// Info logs an info-level message.
func (l *Logger) Info(message string, fields ...map[string]interface{}) {
	var f map[string]interface{}
	if len(fields) > 0 {
		f = fields[0]
	}
	l.log(LogLevelInfo, message, f)
}

// Warn logs a warning-level message.
func (l *Logger) Warn(message string, fields ...map[string]interface{}) {
	var f map[string]interface{}
	if len(fields) > 0 {
		f = fields[0]
	}
	l.log(LogLevelWarn, message, f)
}

// Error logs an error-level message.
func (l *Logger) Error(message string, fields ...map[string]interface{}) {
	var f map[string]interface{}
	if len(fields) > 0 {
		f = fields[0]
	}
	l.log(LogLevelError, message, f)
}

// Entries returns all captured log entries.
func (l *Logger) Entries() []LogEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	copied := make([]LogEntry, len(l.entries))
	copy(copied, l.entries)
	return copied
}

// Lines returns all log entries as formatted strings for ExecutionResult.logs.
func (l *Logger) Lines() []string {
	entries := l.Entries()
	lines := make([]string, len(entries))
	for i, entry := range entries {
		lines[i] = entry.String()
	}
	return lines
}

// Clear resets the log buffer.
func (l *Logger) Clear() {
	l.mu.Lock()
	l.entries = l.entries[:0]
	l.mu.Unlock()
}
