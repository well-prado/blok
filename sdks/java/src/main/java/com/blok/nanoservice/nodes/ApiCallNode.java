package com.blok.nanoservice.nodes;

import com.blok.nanoservice.errors.NodeException;
import com.blok.nanoservice.node.NodeHandler;
import com.blok.nanoservice.types.Context;
import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

/**
 * Node that makes HTTP requests to external APIs.
 * <p>
 * Config:
 * <ul>
 *   <li>url (string, required) - The URL to call</li>
 *   <li>method (string, optional) - HTTP method (default: "GET")</li>
 *   <li>timeout (number, optional) - Timeout in seconds (default: 10)</li>
 *   <li>headers (map, optional) - Additional request headers</li>
 * </ul>
 * Input (request body):
 * <ul>
 *   <li>body (any, optional) - Request body for POST/PUT/PATCH</li>
 * </ul>
 * Output:
 * <ul>
 *   <li>status (number) - HTTP status code</li>
 *   <li>data (any) - Parsed response body</li>
 *   <li>headers (map) - Response headers</li>
 * </ul>
 */
public class ApiCallNode implements NodeHandler {

    private static final Gson GSON = new Gson();

    @Override
    public Object execute(Context ctx, Map<String, Object> config) throws Exception {
        if (config == null) {
            throw NodeException.configuration("config is required for api-call node");
        }

        // Get URL from config (required)
        Object urlVal = config.get("url");
        if (!(urlVal instanceof String url) || url.isEmpty()) {
            throw NodeException.configuration("'url' is required in node config");
        }

        // Get method from config, default to GET
        String method = "GET";
        Object methodVal = config.get("method");
        if (methodVal instanceof String m && !m.isEmpty()) {
            method = m.toUpperCase();
        }

        // Get timeout from config, default to 10 seconds
        int timeout = 10;
        Object timeoutVal = config.get("timeout");
        if (timeoutVal instanceof Number n && n.intValue() > 0) {
            timeout = n.intValue();
        }

        // Build the HTTP request
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(timeout));

        // Set custom headers from config
        Object headersVal = config.get("headers");
        if (headersVal instanceof Map<?, ?> headersMap) {
            for (Map.Entry<?, ?> entry : headersMap.entrySet()) {
                if (entry.getKey() instanceof String key && entry.getValue() instanceof String value) {
                    requestBuilder.header(key, value);
                }
            }
        }

        // Prepare request body
        String requestBody = null;
        Map<String, Object> body = ctx.getRequest().bodyMap();
        if (body != null && body.containsKey("body") && body.get("body") != null) {
            requestBody = GSON.toJson(body.get("body"));
        }

        // Set method and body
        switch (method) {
            case "POST" -> {
                requestBuilder.header("Content-Type", "application/json");
                requestBuilder.POST(HttpRequest.BodyPublishers.ofString(
                        requestBody != null ? requestBody : ""));
            }
            case "PUT" -> {
                requestBuilder.header("Content-Type", "application/json");
                requestBuilder.PUT(HttpRequest.BodyPublishers.ofString(
                        requestBody != null ? requestBody : ""));
            }
            case "DELETE" -> requestBuilder.DELETE();
            default -> requestBuilder.GET();
        }

        // Execute the request
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(timeout))
                    .build();

            HttpResponse<String> response = client.send(
                    requestBuilder.build(),
                    HttpResponse.BodyHandlers.ofString());

            // Try to parse response as JSON, fall back to string
            Object responseData;
            try {
                responseData = GSON.fromJson(response.body(), Object.class);
            } catch (JsonSyntaxException e) {
                responseData = response.body();
            }

            // Collect response headers
            Map<String, String> responseHeaders = new HashMap<>();
            response.headers().map().forEach((key, values) -> {
                if (!values.isEmpty()) {
                    responseHeaders.put(key, values.get(0));
                }
            });

            Map<String, Object> result = new HashMap<>();
            result.put("status", response.statusCode());
            result.put("data", responseData);
            result.put("headers", responseHeaders);
            return result;

        } catch (Exception e) {
            if (e instanceof NodeException) {
                throw e;
            }
            throw NodeException.network("request to " + url + " failed: " + e.getMessage(), e);
        }
    }
}
