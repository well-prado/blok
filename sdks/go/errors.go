package blok

import "fmt"

// ErrorCategory classifies the type of error that occurred.
type ErrorCategory string

const (
	// ErrorCategoryValidation indicates a schema or input validation failure.
	ErrorCategoryValidation ErrorCategory = "VALIDATION"
	// ErrorCategoryExecution indicates an error during node execution.
	ErrorCategoryExecution ErrorCategory = "EXECUTION"
	// ErrorCategoryConfiguration indicates a misconfiguration.
	ErrorCategoryConfiguration ErrorCategory = "CONFIGURATION"
	// ErrorCategoryNetwork indicates a network or connectivity issue.
	ErrorCategoryNetwork ErrorCategory = "NETWORK"
	// ErrorCategoryNotFound indicates a requested resource was not found.
	ErrorCategoryNotFound ErrorCategory = "NOT_FOUND"
)

// NodeError represents a structured error from node execution.
type NodeError struct {
	Message  string                 `json:"message"`
	Code     int                    `json:"code"`
	Category ErrorCategory          `json:"category"`
	Details  map[string]interface{} `json:"details,omitempty"`
	Cause    error                  `json:"-"`
}

// Error implements the error interface.
func (e *NodeError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("[%s] %s: %v", e.Category, e.Message, e.Cause)
	}
	return fmt.Sprintf("[%s] %s", e.Category, e.Message)
}

// Unwrap returns the underlying cause.
func (e *NodeError) Unwrap() error {
	return e.Cause
}

// ToMap converts the error to a map for serialization in ExecutionResult.
func (e *NodeError) ToMap() map[string]interface{} {
	m := map[string]interface{}{
		"message":  e.Message,
		"code":     e.Code,
		"category": string(e.Category),
	}
	if e.Details != nil {
		m["details"] = e.Details
	}
	if e.Cause != nil {
		m["cause"] = e.Cause.Error()
	}
	return m
}

// NewValidationError creates a validation error.
func NewValidationError(message string) *NodeError {
	return &NodeError{
		Message:  message,
		Code:     400,
		Category: ErrorCategoryValidation,
	}
}

// NewExecutionError creates an execution error.
func NewExecutionError(message string, cause error) *NodeError {
	return &NodeError{
		Message:  message,
		Code:     500,
		Category: ErrorCategoryExecution,
		Cause:    cause,
	}
}

// NewConfigurationError creates a configuration error.
func NewConfigurationError(message string) *NodeError {
	return &NodeError{
		Message:  message,
		Code:     500,
		Category: ErrorCategoryConfiguration,
	}
}

// NewNetworkError creates a network error.
func NewNetworkError(message string, cause error) *NodeError {
	return &NodeError{
		Message:  message,
		Code:     502,
		Category: ErrorCategoryNetwork,
		Cause:    cause,
	}
}

// NewNotFoundError creates a not-found error.
func NewNotFoundError(message string) *NodeError {
	return &NodeError{
		Message:  message,
		Code:     404,
		Category: ErrorCategoryNotFound,
	}
}
