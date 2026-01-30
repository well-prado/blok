package com.blok.blok.types;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Represents the execution result returned to the Blok runner.
 * <p>
 * The {@code logs} and {@code metrics} fields are omitted from JSON when null
 * (handled by Gson's null exclusion strategy configured in the server).
 */
public class ExecutionResult {

    private boolean success;
    private Object data;
    private Object errors;
    private List<String> logs;
    private ExecutionMetrics metrics;
    private Map<String, Object> vars;

    public ExecutionResult() {
    }

    private ExecutionResult(boolean success, Object data, Object errors) {
        this.success = success;
        this.data = data;
        this.errors = errors;
    }

    /**
     * Creates a successful execution result with the given data.
     *
     * @param data the result data
     * @return a success result
     */
    public static ExecutionResult success(Object data) {
        return new ExecutionResult(true, data, null);
    }

    /**
     * Creates a failed execution result with an error message.
     *
     * @param message the error message
     * @return an error result
     */
    public static ExecutionResult error(String message) {
        if (message == null) {
            message = "unknown error";
        }
        Map<String, String> errorMap = new HashMap<>();
        errorMap.put("message", message);
        return new ExecutionResult(false, null, errorMap);
    }

    /**
     * Creates a failed execution result with an error message and additional details.
     *
     * @param message the error message
     * @param details additional error details
     * @return an error result with details
     */
    public static ExecutionResult errorWithDetails(String message, Map<String, Object> details) {
        if (message == null) {
            message = "unknown error";
        }
        Map<String, Object> errorMap = new HashMap<>();
        errorMap.put("message", message);
        if (details != null) {
            errorMap.put("details", details);
        }
        return new ExecutionResult(false, null, errorMap);
    }

    /**
     * Fluent setter to attach log lines to this result.
     *
     * @param logs the log lines
     * @return this result
     */
    public ExecutionResult withLogs(List<String> logs) {
        this.logs = logs;
        return this;
    }

    /**
     * Fluent setter to attach execution metrics to this result.
     *
     * @param metrics the execution metrics
     * @return this result
     */
    public ExecutionResult withMetrics(ExecutionMetrics metrics) {
        this.metrics = metrics;
        return this;
    }

    // Getters and setters

    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public Object getData() {
        return data;
    }

    public void setData(Object data) {
        this.data = data;
    }

    public Object getErrors() {
        return errors;
    }

    public void setErrors(Object errors) {
        this.errors = errors;
    }

    public List<String> getLogs() {
        return logs;
    }

    public void setLogs(List<String> logs) {
        this.logs = logs;
    }

    public ExecutionMetrics getMetrics() {
        return metrics;
    }

    public void setMetrics(ExecutionMetrics metrics) {
        this.metrics = metrics;
    }

    public Map<String, Object> getVars() {
        return vars;
    }

    public void setVars(Map<String, Object> vars) {
        this.vars = vars;
    }

    /**
     * Fluent setter to attach context variables to this result.
     *
     * @param vars the context variables
     * @return this result
     */
    public ExecutionResult withVars(Map<String, Object> vars) {
        this.vars = vars;
        return this;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        ExecutionResult that = (ExecutionResult) o;
        return success == that.success &&
                Objects.equals(data, that.data) &&
                Objects.equals(errors, that.errors) &&
                Objects.equals(logs, that.logs) &&
                Objects.equals(metrics, that.metrics) &&
                Objects.equals(vars, that.vars);
    }

    @Override
    public int hashCode() {
        return Objects.hash(success, data, errors, logs, metrics, vars);
    }

    @Override
    public String toString() {
        return "ExecutionResult{" +
                "success=" + success +
                ", data=" + data +
                ", errors=" + errors +
                ", logs=" + logs +
                ", metrics=" + metrics +
                ", vars=" + vars +
                '}';
    }
}
