package com.blok.blok.errors;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Structured {@code BlokError} per master plan §17 — the canonical error
 * contract every Blok node SDK populates the same way.
 *
 * <p>Mirrors the TypeScript {@code BlokError} in
 * {@code core/shared/src/BlokError.ts}, the Python {@code BlokError} in
 * {@code sdks/python3/blok/errors/blok_error.py}, the Go {@code BlokError}
 * in {@code sdks/go/blok_error.go}, and the Rust {@code BlokError} in
 * {@code sdks/rust/src/blok_error.rs}, so node authors writing in any
 * language see the same field shape.
 *
 * <p>Idiomatic usage (master plan §17.5 builder pattern):
 *
 * <pre>{@code
 * throw BlokError.dependency()
 *     .code("POSTGRES_CONNECT_TIMEOUT")
 *     .message("Could not connect to Postgres within 5s")
 *     .description(String.format("Tried host=%s port=%d; timeout=%dms", host, port, dur))
 *     .remediation("Check DATABASE_URL env var and network reachability")
 *     .cause(e)
 *     .retryable(true)
 *     .retryAfterMs(5_000)
 *     .build();
 * }</pre>
 *
 * <p>Extends {@link RuntimeException} so handlers can {@code throw} it
 * directly without changing the {@code throws Exception} signature on
 * {@link com.blok.blok.node.NodeHandler#execute}. The legacy
 * {@link NodeException} (5 categories) stays available for back-compat.
 * New code should prefer {@code BlokError}.
 */
public final class BlokError extends RuntimeException {

    /** SDK identifier reported on auto-enriched errors. */
    public static final String DEFAULT_SDK_NAME = "blok-java";
    /** Runtime kind reported on auto-enriched errors. */
    public static final String DEFAULT_RUNTIME_KIND = "runtime.java";
    /** Default cap on serialized {@code context_snapshot} size in bytes. */
    public static final int CONTEXT_SNAPSHOT_MAX_BYTES = 4096;

    private final BlokErrorCategory category;
    private BlokErrorSeverity severity;
    private final String code;
    private final String description;
    private final String remediation;
    private final String docUrl;
    private int httpStatus;
    private boolean retryable;
    private final long retryAfterMs;
    private final Object details;
    private final Object contextSnapshot;
    private final List<Map<String, Object>> causes;
    private final String stack;
    private final Instant at;

    // Origin — auto-enriched by the gRPC servicer when not set by the handler.
    private String node;
    private String sdk;
    private String sdkVersion;
    private String runtimeKind;

    private BlokError(Builder b) {
        super(b.message != null ? b.message : "", b.causeThrowable);
        this.category = b.category;
        this.severity = b.severity;
        this.code = b.code != null ? b.code : "";
        this.description = b.description != null ? b.description : "";
        this.remediation = b.remediation != null ? b.remediation : "";
        this.docUrl = b.docUrl != null ? b.docUrl : "";
        this.httpStatus = b.httpStatus;
        this.retryable = b.retryable;
        this.retryAfterMs = b.retryAfterMs;
        this.details = b.details;
        this.contextSnapshot = b.contextSnapshot;
        this.stack = b.stack != null ? b.stack : captureStack(this);
        this.at = b.at != null ? b.at : Instant.now();
        this.node = b.node != null ? b.node : "";
        this.sdk = b.sdk != null ? b.sdk : "";
        this.sdkVersion = b.sdkVersion != null ? b.sdkVersion : "";
        this.runtimeKind = b.runtimeKind != null ? b.runtimeKind : "";
        // Cause-chain takes the explicit list when provided, otherwise walks
        // the Throwable cause chain.
        if (b.causes != null) {
            this.causes = b.causes;
        } else if (b.causeThrowable != null) {
            this.causes = flattenCauses(b.causeThrowable);
        } else {
            this.causes = new ArrayList<>();
        }
    }

    // =========================================================================
    // Static factory shortcuts — one per category
    // =========================================================================

    /** Builder for a {@code VALIDATION} error (default 400, non-retryable). */
    public static Builder validation() { return new Builder(BlokErrorCategory.VALIDATION); }
    /** Builder for a {@code CONFIGURATION} error (default 500, non-retryable). */
    public static Builder configuration() { return new Builder(BlokErrorCategory.CONFIGURATION); }
    /** Builder for a {@code DEPENDENCY} error (default 502, retryable). */
    public static Builder dependency() { return new Builder(BlokErrorCategory.DEPENDENCY); }
    /** Builder for a {@code TIMEOUT} error (default 504, retryable). */
    public static Builder timeout() { return new Builder(BlokErrorCategory.TIMEOUT); }
    /** Builder for a {@code PERMISSION} error (default 403, non-retryable). */
    public static Builder permission() { return new Builder(BlokErrorCategory.PERMISSION); }
    /** Builder for a {@code RATE_LIMIT} error (default 429, retryable). */
    public static Builder rateLimit() { return new Builder(BlokErrorCategory.RATE_LIMIT); }
    /** Builder for a {@code NOT_FOUND} error (default 404, non-retryable). */
    public static Builder notFound() { return new Builder(BlokErrorCategory.NOT_FOUND); }
    /** Builder for a {@code CONFLICT} error (default 409, non-retryable). */
    public static Builder conflict() { return new Builder(BlokErrorCategory.CONFLICT); }
    /** Builder for a {@code CANCELLED} error (default 499, non-retryable). */
    public static Builder cancelled() { return new Builder(BlokErrorCategory.CANCELLED); }
    /** Builder for an {@code INTERNAL} error (default 500, non-retryable). */
    public static Builder internal() { return new Builder(BlokErrorCategory.INTERNAL); }
    /** Builder for a {@code PROTOCOL} error (default 502, non-retryable). */
    public static Builder protocol() { return new Builder(BlokErrorCategory.PROTOCOL); }
    /** Builder for a {@code DATA} error (default 422, non-retryable). */
    public static Builder data() { return new Builder(BlokErrorCategory.DATA); }

    /** Generic factory if the category isn't known at compile time. */
    public static Builder of(BlokErrorCategory category) { return new Builder(category); }

    // =========================================================================
    // Conversion — fromUnknown, toMap, fromMap
    // =========================================================================

    /**
     * Wrap any {@link Throwable} or value as a {@code BlokError}. Used by the
     * runner's auto-wrap layer so legacy {@code throw new RuntimeException(...)}
     * still produces a structured error.
     *
     * <p>Categorization heuristic:
     * <ul>
     *   <li>{@code BlokError} — passthrough; missing origin fields filled in.</li>
     *   <li>{@code NodeException} (legacy) — preserves message/details/cause;
     *       category=INTERNAL with code derived from the legacy category.</li>
     *   <li>{@code Throwable} — wraps as INTERNAL with
     *       {@code code=UNCAUGHT_<TYPE>} and the throwable preserved as cause.</li>
     *   <li>{@code Map} — extracts {@code "message"} key, full payload preserved
     *       in {@code details}.</li>
     *   <li>{@code String} — becomes the message.</li>
     *   <li>{@code null} — placeholder {@code "node error"}.</li>
     *   <li>everything else — stringified, payload preserved in details.</li>
     * </ul>
     */
    public static BlokError fromUnknown(Object value, Origin origin) {
        if (value instanceof BlokError be) {
            be.applyOriginIfMissing(origin);
            return be;
        }
        if (value instanceof NodeException ne) {
            Map<String, Object> det = ne.toMap();
            return BlokError.internal()
                    .code("UNCAUGHT_NODEEXCEPTION")
                    .message(ne.getMessage() != null ? ne.getMessage() : "node exception")
                    .cause(ne)
                    .details(det)
                    .applyOrigin(origin)
                    .build();
        }
        if (value instanceof Throwable t) {
            return BlokError.internal()
                    .code(uncaughtCode(t.getClass()))
                    .message(t.getMessage() != null && !t.getMessage().isEmpty()
                            ? t.getMessage()
                            : "Uncaught error")
                    .cause(t)
                    .applyOrigin(origin)
                    .build();
        }
        if (value == null) {
            return BlokError.internal()
                    .code("UNCAUGHT_ERROR")
                    .message("node error")
                    .applyOrigin(origin)
                    .build();
        }
        if (value instanceof String s) {
            Map<String, Object> det = new HashMap<>();
            det.put("message", s);
            return BlokError.internal()
                    .code("UNCAUGHT_ERROR")
                    .message(s)
                    .details(det)
                    .applyOrigin(origin)
                    .build();
        }
        if (value instanceof Map<?, ?> m) {
            Object msg = m.get("message");
            String message = (msg instanceof String ms && !ms.isEmpty()) ? ms : "node error";
            return BlokError.internal()
                    .code("UNCAUGHT_ERROR")
                    .message(message)
                    .details(new HashMap<>(asStringKeyMap(m)))
                    .applyOrigin(origin)
                    .build();
        }
        String repr = String.valueOf(value);
        Map<String, Object> det = new HashMap<>();
        det.put("message", repr);
        return BlokError.internal()
                .code("UNCAUGHT_ERROR")
                .message(repr)
                .details(det)
                .applyOrigin(origin)
                .build();
    }

    /**
     * Lossless serialization to a map matching the proto wire shape
     * (snake_case keys). Inverse of {@link #fromMap}.
     */
    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("category", category.name());
        m.put("severity", severity.name());
        m.put("node", node);
        m.put("sdk", sdk);
        m.put("sdk_version", sdkVersion);
        m.put("runtime_kind", runtimeKind);
        m.put("at", at.toString());
        m.put("message", getMessage() != null ? getMessage() : "");
        m.put("description", description);
        m.put("remediation", remediation);
        m.put("doc_url", docUrl);
        m.put("causes", new ArrayList<>(causes));
        m.put("stack", stack);
        m.put("context_snapshot", contextSnapshot);
        m.put("http_status", httpStatus);
        m.put("retryable", retryable);
        m.put("retry_after_ms", retryAfterMs);
        m.put("details", details);
        return m;
    }

    /**
     * Reconstruct a {@code BlokError} from a JSON-decoded map. Tolerates both
     * snake_case (Java/Python/Go convention) and camelCase (TS payload shape)
     * keys for cross-language fixture compatibility.
     */
    @SuppressWarnings("unchecked")
    public static BlokError fromMap(Map<String, Object> m) {
        BlokErrorCategory category = BlokErrorCategory.parse((String) m.get("category"));
        BlokErrorSeverity severity = BlokErrorSeverity.parse((String) m.get("severity"));
        Builder b = new Builder(category).severity(severity);
        Object code = m.get("code");
        if (code instanceof String c) b.code(c);
        Object msg = m.get("message");
        if (msg instanceof String s) b.message(s);
        Object desc = m.get("description");
        if (desc instanceof String s) b.description(s);
        Object rem = m.get("remediation");
        if (rem instanceof String s) b.remediation(s);
        Object docUrl = pickFirst(m, "doc_url", "docUrl");
        if (docUrl instanceof String s) b.docUrl(s);
        Object http = pickFirst(m, "http_status", "httpStatus");
        if (http instanceof Number n) b.httpStatus(n.intValue());
        Object retryable = m.get("retryable");
        if (retryable instanceof Boolean v) b.retryable(v);
        Object retryAfter = pickFirst(m, "retry_after_ms", "retryAfterMs");
        if (retryAfter instanceof Number n) b.retryAfterMs(n.longValue());
        Object details = m.get("details");
        if (details != null) b.details(details);
        Object snapshot = pickFirst(m, "context_snapshot", "contextSnapshot");
        if (snapshot != null) b.contextSnapshot(snapshot);
        Object node = m.get("node");
        if (node instanceof String s) b.node(s);
        Object sdk = m.get("sdk");
        if (sdk instanceof String s) b.sdk(s);
        Object sdkVer = pickFirst(m, "sdk_version", "sdkVersion");
        if (sdkVer instanceof String s) b.sdkVersion(s);
        Object runtimeKind = pickFirst(m, "runtime_kind", "runtimeKind");
        if (runtimeKind instanceof String s) b.runtimeKind(s);
        Object stack = m.get("stack");
        if (stack instanceof String s) b.stack(s);
        Object at = m.get("at");
        if (at instanceof String s) {
            try {
                b.at(Instant.parse(s));
            } catch (Exception ignored) {
                // keep default
            }
        }
        Object causes = m.get("causes");
        if (causes instanceof List<?> list) {
            List<Map<String, Object>> typed = new ArrayList<>();
            for (Object c : list) {
                if (c instanceof Map<?, ?> cm) {
                    typed.add(asStringKeyMap(cm));
                }
            }
            b.causes(typed);
        }
        return b.build();
    }

    // =========================================================================
    // Origin auto-enrichment
    // =========================================================================

    /**
     * Carrier of the auto-enrichment fields the gRPC servicer fills into a
     * handler-thrown {@code BlokError} when the handler didn't set those
     * fields explicitly.
     */
    public record Origin(String node, String sdk, String sdkVersion, String runtimeKind) {
        /**
         * Build an {@code Origin} populated with the SDK constants
         * ({@link #DEFAULT_SDK_NAME}, {@link #DEFAULT_RUNTIME_KIND}) and the
         * caller-provided node name + SDK version.
         */
        public static Origin defaults(String node, String sdkVersion) {
            return new Origin(
                    node != null ? node : "",
                    DEFAULT_SDK_NAME,
                    sdkVersion != null ? sdkVersion : "",
                    DEFAULT_RUNTIME_KIND
            );
        }
    }

    /** Fill in any missing origin fields on this error. Won't overwrite explicit values. */
    public BlokError applyOriginIfMissing(Origin origin) {
        if (origin == null) return this;
        if (this.node.isEmpty()) this.node = origin.node;
        if (this.sdk.isEmpty()) this.sdk = origin.sdk;
        if (this.sdkVersion.isEmpty()) this.sdkVersion = origin.sdkVersion;
        if (this.runtimeKind.isEmpty()) this.runtimeKind = origin.runtimeKind;
        return this;
    }

    // =========================================================================
    // Getters
    // =========================================================================

    public BlokErrorCategory getCategory() { return category; }
    public BlokErrorSeverity getSeverity() { return severity; }
    public String getCode() { return code; }
    public String getDescription() { return description; }
    public String getRemediation() { return remediation; }
    public String getDocUrl() { return docUrl; }
    public int getHttpStatus() { return httpStatus; }
    public boolean isRetryable() { return retryable; }
    public long getRetryAfterMs() { return retryAfterMs; }
    public Object getDetails() { return details; }
    public Object getContextSnapshot() { return contextSnapshot; }
    public List<Map<String, Object>> getCauses() { return causes; }
    public String getStack() { return stack; }
    public Instant getAt() { return at; }
    public String getNode() { return node; }
    public String getSdk() { return sdk; }
    public String getSdkVersion() { return sdkVersion; }
    public String getRuntimeKind() { return runtimeKind; }

    @Override
    public String toString() {
        return "[" + category.name() + "] " + (getMessage() != null ? getMessage() : "");
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof BlokError that)) return false;
        return httpStatus == that.httpStatus
                && retryable == that.retryable
                && retryAfterMs == that.retryAfterMs
                && category == that.category
                && severity == that.severity
                && Objects.equals(code, that.code)
                && Objects.equals(getMessage(), that.getMessage());
    }

    @Override
    public int hashCode() {
        return Objects.hash(category, code, getMessage(), httpStatus);
    }

    // =========================================================================
    // Builder
    // =========================================================================

    /**
     * Fluent builder per master plan §17.5. Each setter returns {@code this}
     * so chained calls compose without intermediate variables. Call
     * {@link #build()} to finalize.
     */
    public static final class Builder {
        private final BlokErrorCategory category;
        private BlokErrorSeverity severity = BlokErrorSeverity.ERROR;
        private String code;
        private String message;
        private String description;
        private String remediation;
        private String docUrl;
        private int httpStatus;
        private boolean retryable;
        private long retryAfterMs;
        private Object details;
        private Object contextSnapshot;
        private Throwable causeThrowable;
        private List<Map<String, Object>> causes;
        private String stack;
        private Instant at;
        private String node;
        private String sdk;
        private String sdkVersion;
        private String runtimeKind;

        Builder(BlokErrorCategory category) {
            this.category = Objects.requireNonNull(category, "category");
            this.httpStatus = category.defaultHttpStatus();
            this.retryable = category.defaultRetryable();
        }

        public Builder code(String value) { this.code = value; return this; }
        public Builder message(String value) { this.message = value; return this; }
        public Builder description(String value) { this.description = value; return this; }
        public Builder remediation(String value) { this.remediation = value; return this; }
        public Builder docUrl(String value) { this.docUrl = value; return this; }
        public Builder httpStatus(int value) { this.httpStatus = value; return this; }
        public Builder severity(BlokErrorSeverity value) { this.severity = value != null ? value : BlokErrorSeverity.ERROR; return this; }
        public Builder retryable(boolean value) { this.retryable = value; return this; }
        public Builder retryAfter(Duration duration) { this.retryAfterMs = duration != null ? duration.toMillis() : 0; return this; }
        public Builder retryAfterMs(long value) { this.retryAfterMs = value; return this; }
        public Builder details(Object value) { this.details = value; return this; }
        public Builder contextSnapshot(Object value) { this.contextSnapshot = value; return this; }
        public Builder cause(Throwable value) { this.causeThrowable = value; return this; }
        public Builder causes(List<Map<String, Object>> value) { this.causes = value; return this; }
        public Builder stack(String value) { this.stack = value; return this; }
        public Builder at(Instant value) { this.at = value; return this; }
        public Builder node(String value) { this.node = value; return this; }
        public Builder sdk(String value) { this.sdk = value; return this; }
        public Builder sdkVersion(String value) { this.sdkVersion = value; return this; }
        public Builder runtimeKind(String value) { this.runtimeKind = value; return this; }

        /**
         * Apply origin fields, only filling unset ones. Use this in the
         * runtime-side wrapping path; explicit handler-set values win.
         */
        public Builder applyOrigin(Origin origin) {
            if (origin == null) return this;
            if (this.node == null || this.node.isEmpty()) this.node = origin.node;
            if (this.sdk == null || this.sdk.isEmpty()) this.sdk = origin.sdk;
            if (this.sdkVersion == null || this.sdkVersion.isEmpty()) this.sdkVersion = origin.sdkVersion;
            if (this.runtimeKind == null || this.runtimeKind.isEmpty()) this.runtimeKind = origin.runtimeKind;
            return this;
        }

        public BlokError build() {
            return new BlokError(this);
        }
    }

    // =========================================================================
    // Cause-chain flattening
    // =========================================================================

    /**
     * Walk a Throwable's {@code getCause()} chain and produce a flat list of
     * payloads. Cycle-safe; lifts a {@code BlokError} link in directly so
     * cross-wire serialization doesn't double-count nested chains.
     */
    public static List<Map<String, Object>> flattenCauses(Throwable cause) {
        List<Map<String, Object>> causes = new ArrayList<>();
        Set<Throwable> visited = new HashSet<>();
        Throwable current = cause;
        while (current != null && !visited.contains(current)) {
            visited.add(current);
            if (current instanceof BlokError be) {
                Map<String, Object> payload = be.toMap();
                payload.put("causes", new ArrayList<>());
                causes.add(payload);
                causes.addAll(be.getCauses());
                return causes;
            }
            causes.add(throwableToPayload(current));
            current = current.getCause();
        }
        return causes;
    }

    private static Map<String, Object> throwableToPayload(Throwable t) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", uncaughtCode(t.getClass()));
        m.put("category", BlokErrorCategory.INTERNAL.name());
        m.put("severity", BlokErrorSeverity.ERROR.name());
        m.put("node", "");
        m.put("sdk", "");
        m.put("sdk_version", "");
        m.put("runtime_kind", "");
        m.put("at", Instant.now().toString());
        m.put("message", t.getMessage() != null ? t.getMessage() : "Uncaught error");
        m.put("description", "");
        m.put("remediation", "");
        m.put("doc_url", "");
        m.put("causes", new ArrayList<>());
        m.put("stack", captureStack(t));
        m.put("context_snapshot", null);
        m.put("http_status", 500);
        m.put("retryable", false);
        m.put("retry_after_ms", 0L);
        m.put("details", null);
        return m;
    }

    /**
     * Derive an {@code UNCAUGHT_<TYPE>} code from a class. Mirrors the Python
     * {@code UNCAUGHT_CONNECTIONERROR} and Go {@code UNCAUGHT_<TYPE>}
     * conventions: simple class name, alphanumerics only, uppercased.
     */
    static String uncaughtCode(Class<?> cls) {
        if (cls == null) return "UNCAUGHT_ERROR";
        String simple = cls.getSimpleName();
        StringBuilder sb = new StringBuilder(simple.length());
        for (int i = 0; i < simple.length(); i++) {
            char c = simple.charAt(i);
            if (Character.isLetterOrDigit(c)) {
                sb.append(Character.toUpperCase(c));
            }
        }
        return sb.length() == 0 ? "UNCAUGHT_ERROR" : "UNCAUGHT_" + sb;
    }

    private static String captureStack(Throwable t) {
        if (t == null) return "";
        StringWriter sw = new StringWriter();
        try (PrintWriter pw = new PrintWriter(sw)) {
            t.printStackTrace(pw);
        }
        return sw.toString();
    }

    // =========================================================================
    // Internal map helpers
    // =========================================================================

    private static Object pickFirst(Map<String, Object> m, String... keys) {
        for (String k : keys) {
            if (m.containsKey(k)) return m.get(k);
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asStringKeyMap(Map<?, ?> raw) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : raw.entrySet()) {
            out.put(String.valueOf(e.getKey()), e.getValue());
        }
        return out;
    }

    /** Visible for testing. */
    static Collection<Class<?>> allCategoryClasses() {
        return Arrays.asList(BlokErrorCategory.class, BlokErrorSeverity.class);
    }
}
