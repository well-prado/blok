package com.blok.blok.errors;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for the structured {@link BlokError} per master plan §17.
 *
 * <p>Coverage parallels Python ({@code test_blok_error.py}), Go
 * ({@code blok_error_test.go}), and Rust ({@code blok_error::tests}). Each
 * SDK exhaustively tests the same API surface so the cross-language wire
 * shape stays in lockstep.
 */
class BlokErrorTest {

    // ===== Category defaults =================================================

    @Test
    void categoryDefaultStatusMatchesTable() {
        assertEquals(400, BlokErrorCategory.VALIDATION.defaultHttpStatus());
        assertEquals(500, BlokErrorCategory.CONFIGURATION.defaultHttpStatus());
        assertEquals(502, BlokErrorCategory.DEPENDENCY.defaultHttpStatus());
        assertEquals(504, BlokErrorCategory.TIMEOUT.defaultHttpStatus());
        assertEquals(403, BlokErrorCategory.PERMISSION.defaultHttpStatus());
        assertEquals(429, BlokErrorCategory.RATE_LIMIT.defaultHttpStatus());
        assertEquals(404, BlokErrorCategory.NOT_FOUND.defaultHttpStatus());
        assertEquals(409, BlokErrorCategory.CONFLICT.defaultHttpStatus());
        assertEquals(499, BlokErrorCategory.CANCELLED.defaultHttpStatus());
        assertEquals(500, BlokErrorCategory.INTERNAL.defaultHttpStatus());
        assertEquals(502, BlokErrorCategory.PROTOCOL.defaultHttpStatus());
        assertEquals(422, BlokErrorCategory.DATA.defaultHttpStatus());
    }

    @Test
    void categoryDefaultRetryableMatchesTable() {
        assertTrue(BlokErrorCategory.DEPENDENCY.defaultRetryable());
        assertTrue(BlokErrorCategory.TIMEOUT.defaultRetryable());
        assertTrue(BlokErrorCategory.RATE_LIMIT.defaultRetryable());
        assertFalse(BlokErrorCategory.VALIDATION.defaultRetryable());
        assertFalse(BlokErrorCategory.INTERNAL.defaultRetryable());
        assertFalse(BlokErrorCategory.CONFLICT.defaultRetryable());
    }

    @Test
    void categoryParseUnknownFallsBackToInternal() {
        assertEquals(BlokErrorCategory.DEPENDENCY, BlokErrorCategory.parse("DEPENDENCY"));
        assertEquals(BlokErrorCategory.INTERNAL, BlokErrorCategory.parse("not-a-thing"));
        assertEquals(BlokErrorCategory.INTERNAL, BlokErrorCategory.parse(null));
    }

    @Test
    void severityParseFallsBackToError() {
        assertEquals(BlokErrorSeverity.INFO, BlokErrorSeverity.parse("INFO"));
        assertEquals(BlokErrorSeverity.ERROR, BlokErrorSeverity.parse("xyz"));
        assertEquals(BlokErrorSeverity.ERROR, BlokErrorSeverity.parse(null));
    }

    // ===== Builder =========================================================

    @Test
    void builderDependencyDefaults() {
        BlokError e = BlokError.dependency().code("X").message("y").build();
        assertEquals(BlokErrorCategory.DEPENDENCY, e.getCategory());
        assertEquals(502, e.getHttpStatus());
        assertTrue(e.isRetryable());
        assertEquals(BlokErrorSeverity.ERROR, e.getSeverity());
    }

    @Test
    void builderValidationDefaults() {
        BlokError e = BlokError.validation().code("V").message("v").build();
        assertEquals(BlokErrorCategory.VALIDATION, e.getCategory());
        assertEquals(400, e.getHttpStatus());
        assertFalse(e.isRetryable());
    }

    @Test
    void builderOverridesTakePriority() {
        BlokError e = BlokError.dependency()
                .httpStatus(599)
                .retryable(false)
                .severity(BlokErrorSeverity.FATAL)
                .build();
        assertEquals(599, e.getHttpStatus());
        assertFalse(e.isRetryable());
        assertEquals(BlokErrorSeverity.FATAL, e.getSeverity());
    }

    @Test
    void builderRetryAfterDurationToMs() {
        BlokError e = BlokError.rateLimit().retryAfter(Duration.ofSeconds(5)).build();
        assertEquals(5_000, e.getRetryAfterMs());
    }

    @Test
    void builderRetryAfterMsDirect() {
        BlokError e = BlokError.timeout().retryAfterMs(750L).build();
        assertEquals(750L, e.getRetryAfterMs());
    }

    @Test
    void builderDetailsRoundTrip() {
        Map<String, Object> details = new HashMap<>();
        details.put("issues", List.of(Map.of("path", List.of("email"))));
        BlokError e = BlokError.validation().details(details).build();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> issues = (List<Map<String, Object>>) ((Map<String, Object>) e.getDetails()).get("issues");
        assertEquals("email", ((List<?>) issues.get(0).get("path")).get(0));
    }

    @Test
    void builderCausePopulatesCausesList() {
        IOException io = new IOException("nope");
        BlokError e = BlokError.dependency().cause(io).build();
        assertFalse(e.getCauses().isEmpty());
        assertEquals("INTERNAL", e.getCauses().get(0).get("category"));
        assertEquals("nope", e.getCauses().get(0).get("message"));
    }

    @Test
    void builderApplyOriginFillsOnlyMissing() {
        BlokError.Origin origin = BlokError.Origin.defaults("my-node", "1.2.3");
        BlokError e = BlokError.dependency().sdk("custom").applyOrigin(origin).build();
        assertEquals("custom", e.getSdk());          // explicit value preserved
        assertEquals("my-node", e.getNode());         // empty filled
        assertEquals("1.2.3", e.getSdkVersion());
        assertEquals("runtime.java", e.getRuntimeKind());
    }

    @Test
    void allTwelveCategoryFactoriesProduceCorrectCategory() {
        assertEquals(BlokErrorCategory.VALIDATION, BlokError.validation().build().getCategory());
        assertEquals(BlokErrorCategory.CONFIGURATION, BlokError.configuration().build().getCategory());
        assertEquals(BlokErrorCategory.DEPENDENCY, BlokError.dependency().build().getCategory());
        assertEquals(BlokErrorCategory.TIMEOUT, BlokError.timeout().build().getCategory());
        assertEquals(BlokErrorCategory.PERMISSION, BlokError.permission().build().getCategory());
        assertEquals(BlokErrorCategory.RATE_LIMIT, BlokError.rateLimit().build().getCategory());
        assertEquals(BlokErrorCategory.NOT_FOUND, BlokError.notFound().build().getCategory());
        assertEquals(BlokErrorCategory.CONFLICT, BlokError.conflict().build().getCategory());
        assertEquals(BlokErrorCategory.CANCELLED, BlokError.cancelled().build().getCategory());
        assertEquals(BlokErrorCategory.INTERNAL, BlokError.internal().build().getCategory());
        assertEquals(BlokErrorCategory.PROTOCOL, BlokError.protocol().build().getCategory());
        assertEquals(BlokErrorCategory.DATA, BlokError.data().build().getCategory());
    }

    @Test
    void ofProducesGenericFactory() {
        BlokError e = BlokError.of(BlokErrorCategory.DATA).code("x").message("y").build();
        assertEquals(BlokErrorCategory.DATA, e.getCategory());
        assertEquals(422, e.getHttpStatus());
    }

    // ===== fromUnknown =====================================================

    @Test
    void fromUnknownPassesThroughTypedBlokError() {
        BlokError.Origin origin = BlokError.Origin.defaults("auto-node", "1.2.3");
        BlokError original = BlokError.rateLimit().code("UPSTREAM_RATE_LIMITED").message("limit hit").build();
        BlokError recovered = BlokError.fromUnknown(original, origin);
        assertSame(original, recovered);
        // Origin auto-enrichment kicked in.
        assertEquals("auto-node", recovered.getNode());
        assertEquals("1.2.3", recovered.getSdkVersion());
        assertEquals(BlokErrorCategory.RATE_LIMIT, recovered.getCategory());
    }

    @Test
    void fromUnknownWrapsThrowable() {
        BlokError.Origin origin = BlokError.Origin.defaults("auto", "1.0.0");
        IOException cause = new IOException("disk full");
        BlokError wrapped = BlokError.fromUnknown(cause, origin);
        assertEquals(BlokErrorCategory.INTERNAL, wrapped.getCategory());
        assertEquals("disk full", wrapped.getMessage());
        assertTrue(wrapped.getCode().startsWith("UNCAUGHT_"));
    }

    @Test
    void fromUnknownWrapsString() {
        BlokError wrapped = BlokError.fromUnknown("boom", BlokError.Origin.defaults("x", "1.0.0"));
        assertEquals(BlokErrorCategory.INTERNAL, wrapped.getCategory());
        assertEquals("boom", wrapped.getMessage());
        assertEquals("UNCAUGHT_ERROR", wrapped.getCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> details = (Map<String, Object>) wrapped.getDetails();
        assertEquals("boom", details.get("message"));
    }

    @Test
    void fromUnknownWrapsMap() {
        Map<String, Object> raw = new HashMap<>();
        raw.put("message", "from-map");
        raw.put("custom", 42);
        BlokError wrapped = BlokError.fromUnknown(raw, BlokError.Origin.defaults("x", "1.0.0"));
        assertEquals("from-map", wrapped.getMessage());
        assertEquals(BlokErrorCategory.INTERNAL, wrapped.getCategory());
        @SuppressWarnings("unchecked")
        Map<String, Object> details = (Map<String, Object>) wrapped.getDetails();
        assertEquals(42, details.get("custom"));
    }

    @Test
    void fromUnknownHandlesNull() {
        BlokError wrapped = BlokError.fromUnknown(null, BlokError.Origin.defaults("x", "1.0.0"));
        assertEquals("node error", wrapped.getMessage());
        assertEquals(BlokErrorCategory.INTERNAL, wrapped.getCategory());
    }

    @Test
    void fromUnknownWrapsLegacyNodeException() {
        BlokError.Origin origin = BlokError.Origin.defaults("x", "1.0.0");
        NodeException legacy = NodeException.network("postgres unreachable");
        BlokError wrapped = BlokError.fromUnknown(legacy, origin);
        assertEquals(BlokErrorCategory.INTERNAL, wrapped.getCategory());
        assertEquals("UNCAUGHT_NODEEXCEPTION", wrapped.getCode());
        assertEquals("postgres unreachable", wrapped.getMessage());
        assertNotNull(wrapped.getDetails());
    }

    // ===== toMap / fromMap =================================================

    @Test
    void toMapAndFromMapRoundTrip() {
        Map<String, Object> details = new HashMap<>();
        details.put("a", 1);
        BlokError e = BlokError.dependency()
                .code("CODE")
                .message("msg")
                .description("desc")
                .remediation("rem")
                .docUrl("https://example.com")
                .retryable(true)
                .retryAfterMs(1234L)
                .details(details)
                .node("n")
                .sdk("blok-java")
                .sdkVersion("1.0.0")
                .runtimeKind("runtime.java")
                .build();

        Map<String, Object> map = e.toMap();
        assertEquals("DEPENDENCY", map.get("category"));
        assertEquals("CODE", map.get("code"));
        assertEquals(502, map.get("http_status"));
        assertEquals(1234L, map.get("retry_after_ms"));

        BlokError restored = BlokError.fromMap(map);
        assertEquals(BlokErrorCategory.DEPENDENCY, restored.getCategory());
        assertEquals("CODE", restored.getCode());
        assertEquals("msg", restored.getMessage());
        assertEquals("desc", restored.getDescription());
        assertEquals(1234L, restored.getRetryAfterMs());
        assertEquals("https://example.com", restored.getDocUrl());
    }

    @Test
    void fromMapAcceptsCamelCaseKeys() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("category", "RATE_LIMIT");
        raw.put("severity", "ERROR");
        raw.put("code", "RL");
        raw.put("message", "too many");
        raw.put("httpStatus", 429);
        raw.put("retryable", true);
        raw.put("retryAfterMs", 60_000);
        raw.put("at", "2026-04-29T00:00:00Z");
        raw.put("sdkVersion", "1.0.0");
        raw.put("runtimeKind", "runtime.java");
        raw.put("docUrl", "https://docs/example");
        BlokError e = BlokError.fromMap(raw);
        assertEquals(BlokErrorCategory.RATE_LIMIT, e.getCategory());
        assertEquals(429, e.getHttpStatus());
        assertEquals(60_000L, e.getRetryAfterMs());
        assertEquals("1.0.0", e.getSdkVersion());
        assertEquals("runtime.java", e.getRuntimeKind());
        assertEquals("https://docs/example", e.getDocUrl());
    }

    @Test
    void fromMapAcceptsCausesList() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("category", "DEPENDENCY");
        raw.put("severity", "ERROR");
        raw.put("code", "X");
        raw.put("message", "y");
        Map<String, Object> cause = new LinkedHashMap<>();
        cause.put("message", "inner");
        cause.put("category", "INTERNAL");
        raw.put("causes", List.of(cause));
        BlokError e = BlokError.fromMap(raw);
        assertEquals(1, e.getCauses().size());
        assertEquals("inner", e.getCauses().get(0).get("message"));
    }

    // ===== Display / RuntimeException semantics ============================

    @Test
    void toStringFormatsCategoryAndMessage() {
        BlokError e = BlokError.dependency().code("X").message("nope").build();
        assertEquals("[DEPENDENCY] nope", e.toString());
    }

    @Test
    void canBeThrownAsRuntimeException() {
        BlokError e = BlokError.timeout().code("X").message("y").build();
        assertThrows(BlokError.class, () -> { throw e; });
    }

    // ===== uncaught_code derivation ========================================

    @Test
    void uncaughtCodeStripsAndUppercasesSimpleName() {
        assertEquals("UNCAUGHT_IOEXCEPTION", BlokError.uncaughtCode(IOException.class));
        assertEquals("UNCAUGHT_BLOKERROR", BlokError.uncaughtCode(BlokError.class));
        assertEquals("UNCAUGHT_ERROR", BlokError.uncaughtCode(null));
    }

    // ===== Cause-chain flattening =========================================

    @Test
    void flattenCausesWalksGetCauseChain() {
        IOException inner = new IOException("inner");
        Exception wrap = new Exception("wrapped", inner);
        var causes = BlokError.flattenCauses(wrap);
        assertEquals(2, causes.size());
        assertEquals("wrapped", causes.get(0).get("message"));
        assertEquals("inner", causes.get(1).get("message"));
    }

    @Test
    void flattenCausesLiftsBlokErrorLink() {
        BlokError inner = BlokError.notFound().code("INNER").message("inner-msg").build();
        var causes = BlokError.flattenCauses(inner);
        assertEquals("INNER", causes.get(0).get("code"));
        assertEquals("NOT_FOUND", causes.get(0).get("category"));
    }

    // ===== BuildContextSnapshot ===========================================

    @Test
    void snapshotPreservesSmallPayload() {
        Map<String, Object> inputs = new HashMap<>();
        inputs.put("a", 1);
        Map<String, Object> vars = new HashMap<>();
        vars.put("k1", "v1");
        Map<String, Object> snap = BuildContextSnapshot.of(inputs, vars);
        assertEquals(1, ((Map<?, ?>) snap.get("inputs")).get("a"));
        assertEquals("v1", ((Map<?, ?>) snap.get("vars")).get("k1"));
    }

    @Test
    void snapshotCapsAtMaxBytes() {
        Map<String, Object> inputs = new HashMap<>();
        Map<String, Object> vars = new HashMap<>();
        // 80 keys with 100-char values each — well over 4 KB combined.
        String filler = "x".repeat(100);
        for (int i = 0; i < 80; i++) {
            vars.put(String.format("k%03d", i), filler);
        }
        Map<String, Object> snap = BuildContextSnapshot.of(inputs, vars);
        int bytes = new com.google.gson.Gson().toJson(snap).getBytes().length;
        assertTrue(bytes <= BlokError.CONTEXT_SNAPSHOT_MAX_BYTES + 64,
                "snapshot " + bytes + " bytes exceeded budget " + BlokError.CONTEXT_SNAPSHOT_MAX_BYTES);
    }

    @Test
    void snapshotKeepsLastNKeys() {
        Map<String, Object> inputs = new HashMap<>();
        Map<String, Object> vars = new HashMap<>();
        for (int i = 0; i < 32; i++) {
            vars.put(String.format("k%02d", i), i);
        }
        Map<String, Object> snap = BuildContextSnapshot.of(inputs, vars, 0, 5);
        Map<?, ?> kept = (Map<?, ?>) snap.get("vars");
        assertEquals(5, kept.size());
        // Sorted insertion → "last 5" of "k00..k31" = k27..k31.
        assertTrue(kept.containsKey("k31"));
        assertFalse(kept.containsKey("k00"));
    }

    @Test
    void snapshotDisablesVarKeysWhenZero() {
        Map<String, Object> inputs = new HashMap<>();
        Map<String, Object> vars = new HashMap<>();
        vars.put("only", 1);
        Map<String, Object> snap = BuildContextSnapshot.of(inputs, vars, 0, 0);
        assertTrue(((Map<?, ?>) snap.get("vars")).isEmpty());
    }

    // ===== Origin ==========================================================

    @Test
    void originDefaultsUsesSdkConstants() {
        BlokError.Origin o = BlokError.Origin.defaults("n", "1.2.3");
        assertEquals(BlokError.DEFAULT_SDK_NAME, o.sdk());
        assertEquals(BlokError.DEFAULT_RUNTIME_KIND, o.runtimeKind());
        assertEquals("n", o.node());
        assertEquals("1.2.3", o.sdkVersion());
    }

    @Test
    void applyOriginIfMissingPreservesExplicitFields() {
        BlokError e = BlokError.internal().node("explicit").build();
        e.applyOriginIfMissing(BlokError.Origin.defaults("auto", "1.0.0"));
        assertEquals("explicit", e.getNode());
        assertEquals(BlokError.DEFAULT_SDK_NAME, e.getSdk());
        assertEquals(BlokError.DEFAULT_RUNTIME_KIND, e.getRuntimeKind());
    }
}
