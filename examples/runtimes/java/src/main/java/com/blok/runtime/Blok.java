package com.blok.runtime;

import java.util.Map;

/**
 * Blok SDK for Java - Core types and interfaces
 */
public class Blok {

    /**
     * Context represents the workflow execution context
     */
    public static class Context {
        public String id;
        public String workflow_name;
        public String workflow_path;
        public Request request;
        public Response response;
        public Map<String, Object> vars;
        public Map<String, String> env;

        public Context() {}
    }

    /**
     * Request represents the incoming HTTP request data
     */
    public static class Request {
        public Object body;
        public Map<String, String> headers;
        public Map<String, String> params;
        public Map<String, String> query;
        public String method;
        public String url;
        public Map<String, String> cookies;
        public String baseUrl;

        public Request() {}
    }

    /**
     * Response represents the workflow response
     */
    public static class Response {
        public Object data;
        public String contentType;
        public boolean success;
        public Object error;

        public Response() {
            this.success = true;
        }
    }

    /**
     * NodeConfig represents node-specific configuration
     */
    public static class NodeConfig {
        public String name;
        public String path;
        public Map<String, Object> config;

        public NodeConfig() {}
    }

    /**
     * ExecutionRequest is the request received from the Blok runner
     */
    public static class ExecutionRequest {
        public NodeConfig node;
        public Context context;

        public ExecutionRequest() {}
    }

    /**
     * ExecutionResult is the response returned to the Blok runner
     */
    public static class ExecutionResult {
        public boolean success;
        public Object data;
        public Object errors;
        public String[] logs;
        public Map<String, Object> metrics;

        public ExecutionResult() {
            this.success = true;
        }

        public ExecutionResult(boolean success, Object data, Object errors) {
            this.success = success;
            this.data = data;
            this.errors = errors;
        }
    }

    /**
     * NodeHandler is the interface that all Blok nodes must implement
     */
    public interface NodeHandler {
        Object execute(Context context, Map<String, Object> config) throws Exception;
    }

    /**
     * HealthStatus represents the health status of the runtime
     */
    public static class HealthStatus {
        public String status;
        public String version;
        public String[] nodes_loaded;

        public HealthStatus(String version, String[] nodesLoaded) {
            this.status = "healthy";
            this.version = version;
            this.nodes_loaded = nodesLoaded;
        }
    }
}
