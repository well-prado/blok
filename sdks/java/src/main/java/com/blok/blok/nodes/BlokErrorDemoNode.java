package com.blok.blok.nodes;

import com.blok.blok.errors.BlokError;
import com.blok.blok.errors.BuildContextSnapshot;
import com.blok.blok.node.NodeHandler;
import com.blok.blok.types.Context;

import java.io.IOException;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Example node demonstrating the structured {@link BlokError} API per master
 * plan §17.
 *
 * <p>Used by the cross-language E2E test
 * ({@code core/runner/__tests__/integration/runtimes/java-grpc.integration.test.ts})
 * to verify that a Java-side structured error flows through the gRPC wire
 * to the runner with every field preserved (category, severity, code,
 * remediation, retryable hints, cause chain, context snapshot).
 *
 * <p>Triggered via the {@code mode} config:
 * <ul>
 *   <li>{@code mode="dependency"} (default) — throws
 *       {@code BlokError.dependency()} with a cause chain rooted in an
 *       {@link IOException}.</li>
 *   <li>{@code mode="rate-limit"} — throws {@code BlokError.rateLimit()}
 *       with {@code retryAfterMs}.</li>
 *   <li>{@code mode="validation"} — throws {@code BlokError.validation()}
 *       with {@code details.issues} (Zod-style).</li>
 *   <li>{@code mode="ok"} — returns success.</li>
 * </ul>
 */
public class BlokErrorDemoNode implements NodeHandler {

    @Override
    public Object execute(Context ctx, Map<String, Object> config) {
        String mode = "dependency";
        if (config != null) {
            Object m = config.get("mode");
            if (m instanceof String s && !s.isEmpty()) mode = s;
        }

        if ("ok".equals(mode)) {
            Map<String, Object> ok = new HashMap<>();
            ok.put("ok", true);
            ok.put("language", "java");
            return ok;
        }

        Map<String, Object> snapshot = BuildContextSnapshot.of(
                config != null ? config : Map.of(),
                ctx != null && ctx.getVars() != null ? ctx.getVars() : Map.of()
        );

        if ("rate-limit".equals(mode)) {
            Map<String, Object> details = new HashMap<>();
            details.put("limit", 5000);
            details.put("remaining", 0);
            throw BlokError.rateLimit()
                    .code("UPSTREAM_RATE_LIMITED")
                    .message("Upstream API returned 429")
                    .description("GitHub API rate limit hit (5000 req/hr).")
                    .remediation("Wait until the X-RateLimit-Reset header timestamp.")
                    .retryAfterMs(60_000)
                    .docUrl("https://docs.example.com/errors/rate-limit")
                    .details(details)
                    .contextSnapshot(snapshot)
                    .build();
        }

        if ("validation".equals(mode)) {
            Map<String, Object> details = new HashMap<>();
            details.put("issues", List.of(
                    Map.of("path", List.of("email"), "message", "Required"),
                    Map.of("path", List.of("name"), "message", "Required")
            ));
            throw BlokError.validation()
                    .code("VALIDATION_FAILED")
                    .message("2 validation issues")
                    .description("Inputs didn't match the node's schema.")
                    .remediation("Provide both `email` and `name`.")
                    .details(details)
                    .contextSnapshot(snapshot)
                    .build();
        }

        // default: dependency with a cause chain rooted in an IOException.
        IOException cause = new IOException("[Errno 61] Connection refused");
        Map<String, Object> details = new HashMap<>();
        details.put("host", "db.internal");
        details.put("port", 5432);
        details.put("timeout_ms", 5000);
        throw BlokError.dependency()
                .code("POSTGRES_CONNECT_TIMEOUT")
                .message("Could not connect to Postgres within 5s")
                .description("Tried host=db.internal port=5432; timeout=5000ms")
                .remediation("Check DATABASE_URL env var and network reachability")
                .cause(cause)
                .retryable(true)
                .retryAfter(Duration.ofSeconds(5))
                .docUrl("https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT")
                .details(details)
                .contextSnapshot(snapshot)
                .build();
    }
}
