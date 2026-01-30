package com.blok.blok.types;

import com.google.gson.Gson;
import com.google.gson.annotations.SerializedName;
import com.google.gson.reflect.TypeToken;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Represents the incoming HTTP request data passed through the workflow context.
 */
public class Request {

    private Object body;
    private Map<String, String> headers;
    private Map<String, String> params;
    private Map<String, String> query;
    private String method;
    private String url;
    private Map<String, String> cookies;

    @SerializedName("baseUrl")
    private String baseUrl;

    public Request() {
        this.headers = new HashMap<>();
        this.params = new HashMap<>();
        this.query = new HashMap<>();
        this.cookies = new HashMap<>();
    }

    /**
     * Returns the request body as a Map, or null if the body is not a map.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> bodyMap() {
        if (body instanceof Map) {
            return (Map<String, Object>) body;
        }
        if (body == null) {
            return null;
        }
        // Try to convert via Gson if it's some other type
        try {
            Gson gson = new Gson();
            String json = gson.toJson(body);
            return gson.fromJson(json, new TypeToken<Map<String, Object>>() {}.getType());
        } catch (Exception e) {
            return null;
        }
    }

    // Getters and setters

    public Object getBody() {
        return body;
    }

    public void setBody(Object body) {
        this.body = body;
    }

    public Map<String, String> getHeaders() {
        return headers;
    }

    public void setHeaders(Map<String, String> headers) {
        this.headers = headers != null ? headers : new HashMap<>();
    }

    public Map<String, String> getParams() {
        return params;
    }

    public void setParams(Map<String, String> params) {
        this.params = params != null ? params : new HashMap<>();
    }

    public Map<String, String> getQuery() {
        return query;
    }

    public void setQuery(Map<String, String> query) {
        this.query = query != null ? query : new HashMap<>();
    }

    public String getMethod() {
        return method;
    }

    public void setMethod(String method) {
        this.method = method;
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public Map<String, String> getCookies() {
        return cookies;
    }

    public void setCookies(Map<String, String> cookies) {
        this.cookies = cookies != null ? cookies : new HashMap<>();
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Request request = (Request) o;
        return Objects.equals(body, request.body) &&
                Objects.equals(headers, request.headers) &&
                Objects.equals(params, request.params) &&
                Objects.equals(query, request.query) &&
                Objects.equals(method, request.method) &&
                Objects.equals(url, request.url) &&
                Objects.equals(cookies, request.cookies) &&
                Objects.equals(baseUrl, request.baseUrl);
    }

    @Override
    public int hashCode() {
        return Objects.hash(body, headers, params, query, method, url, cookies, baseUrl);
    }

    @Override
    public String toString() {
        return "Request{" +
                "body=" + body +
                ", headers=" + headers +
                ", params=" + params +
                ", query=" + query +
                ", method='" + method + '\'' +
                ", url='" + url + '\'' +
                ", cookies=" + cookies +
                ", baseUrl='" + baseUrl + '\'' +
                '}';
    }
}
