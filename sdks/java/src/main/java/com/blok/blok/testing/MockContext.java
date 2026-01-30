package com.blok.blok.testing;

import com.blok.blok.types.Context;
import com.blok.blok.types.Request;
import com.blok.blok.types.Response;

import java.util.HashMap;
import java.util.Map;

/**
 * Fluent builder for creating test {@link Context} instances with sensible defaults.
 * <p>
 * Example:
 * <pre>{@code
 * Context ctx = new MockContext()
 *     .withId("test-123")
 *     .withWorkflow("my-workflow", "/workflows/test")
 *     .withBody(Map.of("name", "World"))
 *     .withVar("key", "value")
 *     .build();
 * }</pre>
 */
public class MockContext {

    private String id = "test-execution-id";
    private String workflowName = "test-workflow";
    private String workflowPath = "/workflows/test";
    private Object body = new HashMap<String, Object>();
    private Map<String, String> headers = new HashMap<>();
    private Map<String, String> params = new HashMap<>();
    private Map<String, String> query = new HashMap<>();
    private String method = "POST";
    private String url = "/test";
    private Map<String, String> cookies = new HashMap<>();
    private String baseUrl = "http://localhost:8080";
    private Map<String, Object> vars = new HashMap<>();
    private Map<String, String> env = new HashMap<>();

    public MockContext() {
    }

    /**
     * Sets the execution ID.
     */
    public MockContext withId(String id) {
        this.id = id;
        return this;
    }

    /**
     * Sets the workflow name and path.
     */
    public MockContext withWorkflow(String name, String path) {
        this.workflowName = name;
        this.workflowPath = path;
        return this;
    }

    /**
     * Sets the request body.
     */
    public MockContext withBody(Object body) {
        this.body = body;
        return this;
    }

    /**
     * Sets the request headers.
     */
    public MockContext withHeaders(Map<String, String> headers) {
        this.headers = headers != null ? new HashMap<>(headers) : new HashMap<>();
        return this;
    }

    /**
     * Sets a single context variable.
     */
    public MockContext withVar(String key, Object value) {
        this.vars.put(key, value);
        return this;
    }

    /**
     * Sets a single environment variable.
     */
    public MockContext withEnv(String key, String value) {
        this.env.put(key, value);
        return this;
    }

    /**
     * Builds and returns the Context.
     */
    public Context build() {
        Context ctx = new Context();
        ctx.setId(id);
        ctx.setWorkflowName(workflowName);
        ctx.setWorkflowPath(workflowPath);

        Request request = new Request();
        request.setBody(body);
        request.setHeaders(new HashMap<>(headers));
        request.setParams(new HashMap<>(params));
        request.setQuery(new HashMap<>(query));
        request.setMethod(method);
        request.setUrl(url);
        request.setCookies(new HashMap<>(cookies));
        request.setBaseUrl(baseUrl);
        ctx.setRequest(request);

        Response response = new Response();
        response.setSuccess(true);
        ctx.setResponse(response);

        ctx.setVars(new HashMap<>(vars));
        ctx.setEnv(new HashMap<>(env));

        return ctx;
    }
}
