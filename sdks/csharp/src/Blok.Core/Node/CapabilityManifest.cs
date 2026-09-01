namespace Blok.Core.Node;

/// <summary>Language-neutral v1 operational metadata from ADR 0003.</summary>
public sealed record CapabilityManifest(
    string Version,
    string Classification,
    IReadOnlyList<string> Effects,
    IReadOnlyList<string> Capabilities,
    IReadOnlyList<string> Secrets,
    string Determinism,
    string Idempotency,
    string Maturity,
    CapabilityResourceBounds? Resources = null,
    IReadOnlyList<string>? Runtimes = null,
    IReadOnlyList<string>? Triggers = null);

public sealed record CapabilityResourceBounds(
    long? MaxDurationMs = null,
    long? MaxMemoryBytes = null,
    long? MaxInputBytes = null,
    long? MaxOutputBytes = null,
    long? MaxConcurrency = null);
