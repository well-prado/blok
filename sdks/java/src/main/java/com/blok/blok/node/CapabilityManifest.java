package com.blok.blok.node;

import java.util.List;

/** Language-neutral v1 operational metadata from ADR 0003. */
public record CapabilityManifest(
        String version,
        String classification,
        List<String> effects,
        List<String> capabilities,
        List<String> secrets,
        String determinism,
        String idempotency,
        String maturity,
        ResourceBounds resources,
        List<String> runtimes,
        List<String> triggers) {

    public record ResourceBounds(
            Long maxDurationMs,
            Long maxMemoryBytes,
            Long maxInputBytes,
            Long maxOutputBytes,
            Long maxConcurrency) {
    }
}
