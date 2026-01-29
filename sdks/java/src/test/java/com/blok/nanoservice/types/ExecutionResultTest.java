package com.blok.nanoservice.types;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for ExecutionResult, including factory methods and JSON serialization.
 */
class ExecutionResultTest {

    private final Gson gson = new GsonBuilder().create();

    @Test
    void successFactoryCreatesSuccessResult() {
        Map<String, Object> data = new HashMap<>();
        data.put("message", "Hello, World!");

        ExecutionResult result = ExecutionResult.success(data);

        assertTrue(result.isSuccess());
        assertNotNull(result.getData());
        assertNull(result.getErrors());
        assertNull(result.getLogs());
        assertNull(result.getMetrics());
    }

    @Test
    void errorFactoryCreatesErrorResult() {
        ExecutionResult result = ExecutionResult.error("something went wrong");

        assertFalse(result.isSuccess());
        assertNull(result.getData());
        assertNotNull(result.getErrors());

        @SuppressWarnings("unchecked")
        Map<String, String> errors = (Map<String, String>) result.getErrors();
        assertEquals("something went wrong", errors.get("message"));
    }

    @Test
    void errorFactoryHandlesNullMessage() {
        ExecutionResult result = ExecutionResult.error(null);

        assertFalse(result.isSuccess());
        @SuppressWarnings("unchecked")
        Map<String, String> errors = (Map<String, String>) result.getErrors();
        assertEquals("unknown error", errors.get("message"));
    }

    @Test
    void errorWithDetailsIncludesDetails() {
        Map<String, Object> details = new HashMap<>();
        details.put("field", "name");
        details.put("reason", "required");

        ExecutionResult result = ExecutionResult.errorWithDetails("validation failed", details);

        assertFalse(result.isSuccess());
        @SuppressWarnings("unchecked")
        Map<String, Object> errors = (Map<String, Object>) result.getErrors();
        assertEquals("validation failed", errors.get("message"));
        assertNotNull(errors.get("details"));
    }

    @Test
    void withLogsAttachesLogs() {
        List<String> logs = Arrays.asList("log line 1", "log line 2");

        ExecutionResult result = ExecutionResult.success("data").withLogs(logs);

        assertNotNull(result.getLogs());
        assertEquals(2, result.getLogs().size());
        assertEquals("log line 1", result.getLogs().get(0));
    }

    @Test
    void withMetricsAttachesMetrics() {
        ExecutionMetrics metrics = new ExecutionMetrics(12.5, null, 1024L);

        ExecutionResult result = ExecutionResult.success("data").withMetrics(metrics);

        assertNotNull(result.getMetrics());
        assertEquals(12.5, result.getMetrics().getDurationMs());
        assertNull(result.getMetrics().getCpuMs());
        assertEquals(1024L, result.getMetrics().getMemoryBytes());
    }

    @Test
    void jsonRoundtripSuccess() {
        Map<String, Object> data = new HashMap<>();
        data.put("key", "value");

        ExecutionResult original = ExecutionResult.success(data)
                .withLogs(List.of("log1"))
                .withMetrics(new ExecutionMetrics(5.0, 2.0, 512L));

        String json = gson.toJson(original);
        assertNotNull(json);

        // Verify JSON contains expected fields
        assertTrue(json.contains("\"success\":true"));
        assertTrue(json.contains("\"key\":\"value\""));
        assertTrue(json.contains("\"duration_ms\":5.0"));
        assertTrue(json.contains("\"memory_bytes\":512"));

        // Roundtrip
        ExecutionResult deserialized = gson.fromJson(json, ExecutionResult.class);
        assertTrue(deserialized.isSuccess());
        assertNotNull(deserialized.getData());
        assertNotNull(deserialized.getLogs());
        assertNotNull(deserialized.getMetrics());
    }

    @Test
    void jsonRoundtripError() {
        ExecutionResult original = ExecutionResult.error("test error");

        String json = gson.toJson(original);
        assertNotNull(json);
        assertTrue(json.contains("\"success\":false"));

        ExecutionResult deserialized = gson.fromJson(json, ExecutionResult.class);
        assertFalse(deserialized.isSuccess());
    }

    @Test
    void jsonOmitsNullLogsAndMetrics() {
        // Using Gson without serializeNulls - null fields won't appear
        Gson compactGson = new GsonBuilder().create();

        ExecutionResult result = ExecutionResult.success("ok");
        String json = compactGson.toJson(result);

        assertFalse(json.contains("\"logs\""));
        assertFalse(json.contains("\"metrics\""));
    }

    @Test
    void equalsAndHashCode() {
        ExecutionResult r1 = ExecutionResult.success("data");
        ExecutionResult r2 = ExecutionResult.success("data");

        assertEquals(r1, r2);
        assertEquals(r1.hashCode(), r2.hashCode());
    }

    @Test
    void notEqualsForDifferentTypes() {
        ExecutionResult success = ExecutionResult.success("data");
        ExecutionResult error = ExecutionResult.error("err");

        assertNotEquals(success, error);
    }

    @Test
    void toStringContainsFields() {
        ExecutionResult result = ExecutionResult.success("test");
        String str = result.toString();

        assertTrue(str.contains("success=true"));
        assertTrue(str.contains("data=test"));
    }

    @Test
    void executionMetricsJsonFieldNames() {
        ExecutionMetrics metrics = new ExecutionMetrics(100.5, 50.2, 2048L);
        String json = gson.toJson(metrics);

        assertTrue(json.contains("\"duration_ms\""));
        assertTrue(json.contains("\"cpu_ms\""));
        assertTrue(json.contains("\"memory_bytes\""));
        assertFalse(json.contains("\"durationMs\""));
    }

    @Test
    void executionMetricsOmitsNull() {
        ExecutionMetrics metrics = new ExecutionMetrics(100.5, null, null);
        Gson compactGson = new GsonBuilder().create();
        String json = compactGson.toJson(metrics);

        assertTrue(json.contains("\"duration_ms\":100.5"));
        assertFalse(json.contains("\"cpu_ms\""));
        assertFalse(json.contains("\"memory_bytes\""));
    }
}
