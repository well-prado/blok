package com.blok.blok.types;

import com.google.gson.annotations.SerializedName;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Represents the workflow execution context passed between nodes.
 * Contains request data, response state, variables, and environment configuration.
 */
public class Context {

    private String id;

    @SerializedName("workflow_name")
    private String workflowName;

    @SerializedName("workflow_path")
    private String workflowPath;

    private Request request;
    private Response response;
    private Map<String, Object> vars;
    private Map<String, String> env;

    public Context() {
        this.request = new Request();
        this.response = new Response();
        this.vars = new HashMap<>();
        this.env = new HashMap<>();
    }

    /**
     * Stores a variable in the context for downstream nodes.
     *
     * @param key   the variable name
     * @param value the variable value
     */
    public void setVar(String key, Object value) {
        if (key == null) {
            throw new IllegalArgumentException("key must not be null");
        }
        if (vars == null) {
            vars = new HashMap<>();
        }
        vars.put(key, value);
    }

    /**
     * Retrieves a variable from the context.
     *
     * @param key the variable name
     * @return the value, or null if not present
     */
    public Object getVar(String key) {
        if (key == null || vars == null) {
            return null;
        }
        return vars.get(key);
    }

    /**
     * Retrieves a string variable from the context.
     *
     * @param key the variable name
     * @return the string value, or empty string if not present or not a string
     */
    public String getVarString(String key) {
        Object value = getVar(key);
        if (value instanceof String) {
            return (String) value;
        }
        return "";
    }

    // Getters and setters

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getWorkflowName() {
        return workflowName;
    }

    public void setWorkflowName(String workflowName) {
        this.workflowName = workflowName;
    }

    public String getWorkflowPath() {
        return workflowPath;
    }

    public void setWorkflowPath(String workflowPath) {
        this.workflowPath = workflowPath;
    }

    public Request getRequest() {
        return request;
    }

    public void setRequest(Request request) {
        this.request = request != null ? request : new Request();
    }

    public Response getResponse() {
        return response;
    }

    public void setResponse(Response response) {
        this.response = response != null ? response : new Response();
    }

    public Map<String, Object> getVars() {
        return vars;
    }

    public void setVars(Map<String, Object> vars) {
        this.vars = vars != null ? vars : new HashMap<>();
    }

    public Map<String, String> getEnv() {
        return env;
    }

    public void setEnv(Map<String, String> env) {
        this.env = env != null ? env : new HashMap<>();
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Context context = (Context) o;
        return Objects.equals(id, context.id) &&
                Objects.equals(workflowName, context.workflowName) &&
                Objects.equals(workflowPath, context.workflowPath) &&
                Objects.equals(request, context.request) &&
                Objects.equals(response, context.response) &&
                Objects.equals(vars, context.vars) &&
                Objects.equals(env, context.env);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id, workflowName, workflowPath, request, response, vars, env);
    }

    @Override
    public String toString() {
        return "Context{" +
                "id='" + id + '\'' +
                ", workflowName='" + workflowName + '\'' +
                ", workflowPath='" + workflowPath + '\'' +
                ", request=" + request +
                ", response=" + response +
                ", vars=" + vars +
                ", env=" + env +
                '}';
    }
}
