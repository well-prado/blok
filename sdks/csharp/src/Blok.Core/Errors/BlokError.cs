using System.Text.Json;

namespace Blok.Core.Errors;

/// <summary>
/// Structured <c>BlokError</c> per master plan §17 — the canonical error
/// contract every Blok node SDK populates the same way.
///
/// <para>Mirrors the TypeScript <c>BlokError</c>, Python <c>BlokError</c>, Go
/// <c>*BlokError</c>, Rust <c>BlokError</c>, and Java <c>BlokError</c>, so
/// node authors writing in any language see the same field shape.</para>
///
/// <para>Idiomatic usage (master plan §17.5 builder pattern):</para>
/// <code>
/// throw BlokError.Dependency()
///     .Code("POSTGRES_CONNECT_TIMEOUT")
///     .Message("Could not connect to Postgres within 5s")
///     .Description($"Tried host={host} port={port}; timeout={dur}ms")
///     .Remediation("Check DATABASE_URL env var and network reachability")
///     .Cause(ex)
///     .Retryable(true)
///     .RetryAfter(TimeSpan.FromSeconds(5))
///     .Details(new Dictionary&lt;string, object?&gt; { ["host"] = host, ["port"] = port })
///     .Build();
/// </code>
///
/// <para>Extends <see cref="Exception"/> so handlers can <c>throw</c> it
/// directly. The legacy <see cref="NodeException"/> (5 categories) stays
/// available for back-compat. New code should prefer <c>BlokError</c>.</para>
/// </summary>
public sealed class BlokError : Exception
{
    /// <summary>SDK identifier reported on auto-enriched errors.</summary>
    public const string DefaultSdkName = "blok-csharp";

    /// <summary>Runtime kind reported on auto-enriched errors.</summary>
    public const string DefaultRuntimeKind = "runtime.csharp";

    /// <summary>Default cap on serialized <c>context_snapshot</c> size in bytes.</summary>
    public const int ContextSnapshotMaxBytes = 4096;

    public BlokErrorCategory Category { get; }
    public BlokErrorSeverity Severity { get; internal set; }
    public string Code { get; }
    public string Description { get; }
    public string Remediation { get; }
    public string DocUrl { get; }
    public int HttpStatus { get; internal set; }
    public bool Retryable { get; internal set; }
    public long RetryAfterMs { get; }
    public object? Details { get; }
    public object? ContextSnapshot { get; }
    public IReadOnlyList<Dictionary<string, object?>> Causes { get; }
    public string Stack { get; }
    public DateTime At { get; }

    // Origin — auto-enriched by the gRPC servicer when not set by the handler.
    public string Node { get; internal set; }
    public string Sdk { get; internal set; }
    public string SdkVersion { get; internal set; }
    public string RuntimeKind { get; internal set; }

    private BlokError(Builder b)
        : base(b.MessageValue ?? string.Empty, b.CauseValue)
    {
        Category = b.CategoryValue;
        Severity = b.SeverityValue;
        Code = b.CodeValue ?? string.Empty;
        Description = b.DescriptionValue ?? string.Empty;
        Remediation = b.RemediationValue ?? string.Empty;
        DocUrl = b.DocUrlValue ?? string.Empty;
        HttpStatus = b.HttpStatusValue;
        Retryable = b.RetryableValue;
        RetryAfterMs = b.RetryAfterMsValue;
        Details = b.DetailsValue;
        ContextSnapshot = b.ContextSnapshotValue;
        Stack = b.StackValue ?? (b.CauseValue?.StackTrace ?? string.Empty);
        At = b.AtValue ?? DateTime.UtcNow;
        Node = b.NodeValue ?? string.Empty;
        Sdk = b.SdkValue ?? string.Empty;
        SdkVersion = b.SdkVersionValue ?? string.Empty;
        RuntimeKind = b.RuntimeKindValue ?? string.Empty;
        if (b.CausesValue is not null)
        {
            Causes = b.CausesValue;
        }
        else if (b.CauseValue is not null)
        {
            Causes = FlattenCauses(b.CauseValue);
        }
        else
        {
            Causes = Array.Empty<Dictionary<string, object?>>();
        }
    }

    public override string ToString() => $"[{Category.AsWire()}] {Message}";

    // =========================================================================
    // Static factory shortcuts — one per category
    // =========================================================================

    /// <summary>Builder for a <c>VALIDATION</c> error (default 400, non-retryable).</summary>
    public static Builder Validation() => new(BlokErrorCategory.Validation);
    /// <summary>Builder for a <c>CONFIGURATION</c> error (default 500, non-retryable).</summary>
    public static Builder Configuration() => new(BlokErrorCategory.Configuration);
    /// <summary>Builder for a <c>DEPENDENCY</c> error (default 502, retryable).</summary>
    public static Builder Dependency() => new(BlokErrorCategory.Dependency);
    /// <summary>Builder for a <c>TIMEOUT</c> error (default 504, retryable).</summary>
    public static Builder Timeout() => new(BlokErrorCategory.Timeout);
    /// <summary>Builder for a <c>PERMISSION</c> error (default 403, non-retryable).</summary>
    public static Builder Permission() => new(BlokErrorCategory.Permission);
    /// <summary>Builder for a <c>RATE_LIMIT</c> error (default 429, retryable).</summary>
    public static Builder RateLimit() => new(BlokErrorCategory.RateLimit);
    /// <summary>Builder for a <c>NOT_FOUND</c> error (default 404, non-retryable).</summary>
    public static Builder NotFound() => new(BlokErrorCategory.NotFound);
    /// <summary>Builder for a <c>CONFLICT</c> error (default 409, non-retryable).</summary>
    public static Builder Conflict() => new(BlokErrorCategory.Conflict);
    /// <summary>Builder for a <c>CANCELLED</c> error (default 499, non-retryable).</summary>
    public static Builder Cancelled() => new(BlokErrorCategory.Cancelled);
    /// <summary>Builder for an <c>INTERNAL</c> error (default 500, non-retryable).</summary>
    public static Builder Internal() => new(BlokErrorCategory.Internal);
    /// <summary>Builder for a <c>PROTOCOL</c> error (default 502, non-retryable).</summary>
    public static Builder Protocol() => new(BlokErrorCategory.Protocol);
    /// <summary>Builder for a <c>DATA</c> error (default 422, non-retryable).</summary>
    /// <remarks>The <c>new</c> modifier hides <see cref="Exception.Data"/> (the
    /// dictionary inherited from <c>Exception</c>) at the type level. Callers
    /// reaching for the dictionary must access it via the base type.</remarks>
    public static new Builder Data() => new(BlokErrorCategory.Data);

    /// <summary>Generic factory if the category isn't known at compile time.</summary>
    public static Builder Of(BlokErrorCategory category) => new(category);

    // =========================================================================
    // Conversion — FromUnknown, ToMap, FromMap
    // =========================================================================

    /// <summary>
    /// Wrap any value as a <c>BlokError</c>. Used by the runner's auto-wrap
    /// layer so legacy <c>throw new InvalidOperationException(...)</c> still
    /// produces a structured error.
    ///
    /// <para>Categorization heuristic:</para>
    /// <list type="bullet">
    ///   <item><c>BlokError</c> — passthrough; missing origin fields filled in.</item>
    ///   <item><c>NodeException</c> (legacy) — preserves message/details/cause; category=INTERNAL.</item>
    ///   <item><c>Exception</c> — wraps as INTERNAL with <c>code=UNCAUGHT_&lt;TYPE&gt;</c>.</item>
    ///   <item><c>IDictionary</c> — extracts <c>"message"</c> key, full payload in details.</item>
    ///   <item><c>string</c> — becomes the message.</item>
    ///   <item><c>null</c> — placeholder <c>"node error"</c>.</item>
    /// </list>
    /// </summary>
    public static BlokError FromUnknown(object? value, BlokErrorOrigin origin)
    {
        if (value is BlokError be)
        {
            be.ApplyOriginIfMissing(origin);
            return be;
        }
        if (value is NodeException ne)
        {
            var details = new Dictionary<string, object?>
            {
                ["message"] = ne.Message,
                ["code"] = ne.Code,
                ["category"] = ne.Category.ToString(),
                ["details"] = ne.Details,
            };
            return Internal()
                .Code("UNCAUGHT_NODEEXCEPTION")
                .Message(ne.Message)
                .Cause(ne)
                .Details(details)
                .ApplyOrigin(origin)
                .Build();
        }
        if (value is Exception ex)
        {
            var msg = string.IsNullOrEmpty(ex.Message) ? "Uncaught error" : ex.Message;
            return Internal()
                .Code(UncaughtCode(ex.GetType()))
                .Message(msg)
                .Cause(ex)
                .ApplyOrigin(origin)
                .Build();
        }
        if (value is null)
        {
            return Internal()
                .Code("UNCAUGHT_ERROR")
                .Message("node error")
                .ApplyOrigin(origin)
                .Build();
        }
        if (value is string s)
        {
            return Internal()
                .Code("UNCAUGHT_ERROR")
                .Message(s)
                .Details(new Dictionary<string, object?> { ["message"] = s })
                .ApplyOrigin(origin)
                .Build();
        }
        if (value is System.Collections.IDictionary dict)
        {
            var typed = AsStringKeyMap(dict);
            var message = typed.TryGetValue("message", out var m) && m is string ms && !string.IsNullOrEmpty(ms)
                ? ms
                : "node error";
            return Internal()
                .Code("UNCAUGHT_ERROR")
                .Message(message)
                .Details(typed)
                .ApplyOrigin(origin)
                .Build();
        }
        var repr = value.ToString() ?? "node error";
        return Internal()
            .Code("UNCAUGHT_ERROR")
            .Message(repr)
            .Details(new Dictionary<string, object?> { ["message"] = repr })
            .ApplyOrigin(origin)
            .Build();
    }

    /// <summary>
    /// Lossless serialization to a map matching the proto wire shape
    /// (snake_case keys). Inverse of <see cref="FromMap"/>.
    /// </summary>
    public Dictionary<string, object?> ToMap() => new()
    {
        ["code"] = Code,
        ["category"] = Category.AsWire(),
        ["severity"] = Severity.AsWire(),
        ["node"] = Node,
        ["sdk"] = Sdk,
        ["sdk_version"] = SdkVersion,
        ["runtime_kind"] = RuntimeKind,
        ["at"] = At.ToString("o"),
        ["message"] = Message,
        ["description"] = Description,
        ["remediation"] = Remediation,
        ["doc_url"] = DocUrl,
        ["causes"] = Causes.Select(c => new Dictionary<string, object?>(c)).ToList(),
        ["stack"] = Stack,
        ["context_snapshot"] = ContextSnapshot,
        ["http_status"] = HttpStatus,
        ["retryable"] = Retryable,
        ["retry_after_ms"] = RetryAfterMs,
        ["details"] = Details,
    };

    /// <summary>
    /// Reconstruct a <c>BlokError</c> from a JSON-decoded map. Tolerates both
    /// <c>snake_case</c> (C#/Java/Python/Go convention) and <c>camelCase</c>
    /// (TS payload shape) keys for cross-language fixture compatibility.
    /// </summary>
    public static BlokError FromMap(IDictionary<string, object?> m)
    {
        var category = BlokErrorCategoryExtensions.Parse(PickFirst(m, "category") as string);
        var severity = BlokErrorSeverityExtensions.Parse(PickFirst(m, "severity") as string);
        var b = new Builder(category).Severity(severity);
        if (PickFirst(m, "code") is string code) b.Code(code);
        if (PickFirst(m, "message") is string message) b.Message(message);
        if (PickFirst(m, "description") is string description) b.Description(description);
        if (PickFirst(m, "remediation") is string remediation) b.Remediation(remediation);
        if (PickFirst(m, "doc_url", "docUrl") is string docUrl) b.DocUrl(docUrl);
        if (TryGetInt(m, out var http, "http_status", "httpStatus")) b.HttpStatus(http);
        if (PickFirst(m, "retryable") is bool retry) b.Retryable(retry);
        if (TryGetLong(m, out var retryAfter, "retry_after_ms", "retryAfterMs")) b.RetryAfterMs(retryAfter);
        if (m.TryGetValue("details", out var details)) b.Details(details);
        var snapshot = PickFirst(m, "context_snapshot", "contextSnapshot");
        if (snapshot is not null) b.ContextSnapshot(snapshot);
        if (PickFirst(m, "node") is string node) b.Node(node);
        if (PickFirst(m, "sdk") is string sdk) b.Sdk(sdk);
        if (PickFirst(m, "sdk_version", "sdkVersion") is string sdkVersion) b.SdkVersion(sdkVersion);
        if (PickFirst(m, "runtime_kind", "runtimeKind") is string runtimeKind) b.RuntimeKind(runtimeKind);
        if (PickFirst(m, "stack") is string stack) b.Stack(stack);
        if (PickFirst(m, "at") is string at && DateTime.TryParse(at, null, System.Globalization.DateTimeStyles.RoundtripKind, out var parsedAt))
        {
            b.At(parsedAt);
        }
        if (m.TryGetValue("causes", out var rawCauses) && rawCauses is System.Collections.IEnumerable causesList)
        {
            var typed = new List<Dictionary<string, object?>>();
            foreach (var c in causesList)
            {
                if (c is System.Collections.IDictionary cm)
                {
                    typed.Add(AsStringKeyMap(cm));
                }
            }
            b.Causes(typed);
        }
        return b.Build();
    }

    // =========================================================================
    // Origin auto-enrichment
    // =========================================================================

    /// <summary>
    /// Fill in any missing origin fields. Won't overwrite explicit values.
    /// </summary>
    public BlokError ApplyOriginIfMissing(BlokErrorOrigin origin)
    {
        if (string.IsNullOrEmpty(Node)) Node = origin.Node;
        if (string.IsNullOrEmpty(Sdk)) Sdk = origin.Sdk;
        if (string.IsNullOrEmpty(SdkVersion)) SdkVersion = origin.SdkVersion;
        if (string.IsNullOrEmpty(RuntimeKind)) RuntimeKind = origin.RuntimeKind;
        return this;
    }

    // =========================================================================
    // Cause-chain flattening
    // =========================================================================

    /// <summary>
    /// Walk an exception's <see cref="Exception.InnerException"/> chain and
    /// produce a flat list of payloads. Cycle-safe; lifts a <see cref="BlokError"/>
    /// link in directly so cross-wire serialization doesn't double-count
    /// nested chains.
    /// </summary>
    public static List<Dictionary<string, object?>> FlattenCauses(Exception cause)
    {
        var causes = new List<Dictionary<string, object?>>();
        var visited = new HashSet<Exception>();
        var current = cause;
        while (current is not null && visited.Add(current))
        {
            if (current is BlokError be)
            {
                var payload = be.ToMap();
                payload["causes"] = new List<Dictionary<string, object?>>();
                causes.Add(payload);
                foreach (var nested in be.Causes)
                {
                    causes.Add(new Dictionary<string, object?>(nested));
                }
                return causes;
            }
            causes.Add(ExceptionToPayload(current));
            current = current.InnerException;
        }
        return causes;
    }

    private static Dictionary<string, object?> ExceptionToPayload(Exception ex) => new()
    {
        ["code"] = UncaughtCode(ex.GetType()),
        ["category"] = BlokErrorCategory.Internal.AsWire(),
        ["severity"] = BlokErrorSeverity.Error.AsWire(),
        ["node"] = "",
        ["sdk"] = "",
        ["sdk_version"] = "",
        ["runtime_kind"] = "",
        ["at"] = DateTime.UtcNow.ToString("o"),
        ["message"] = string.IsNullOrEmpty(ex.Message) ? "Uncaught error" : ex.Message,
        ["description"] = "",
        ["remediation"] = "",
        ["doc_url"] = "",
        ["causes"] = new List<Dictionary<string, object?>>(),
        ["stack"] = ex.StackTrace ?? string.Empty,
        ["context_snapshot"] = null,
        ["http_status"] = 500,
        ["retryable"] = false,
        ["retry_after_ms"] = 0L,
        ["details"] = null,
    };

    /// <summary>
    /// Derive an <c>UNCAUGHT_&lt;TYPE&gt;</c> code from a type. Mirrors the
    /// Python <c>UNCAUGHT_CONNECTIONERROR</c>, Go <c>UNCAUGHT_&lt;TYPE&gt;</c>,
    /// and Java <c>UNCAUGHT_IOEXCEPTION</c> conventions: simple type name,
    /// alphanumerics only, uppercased.
    /// </summary>
    public static string UncaughtCode(Type? type)
    {
        if (type is null) return "UNCAUGHT_ERROR";
        var simple = type.Name;
        var sb = new System.Text.StringBuilder(simple.Length);
        foreach (var c in simple)
        {
            if (char.IsLetterOrDigit(c)) sb.Append(char.ToUpperInvariant(c));
        }
        return sb.Length == 0 ? "UNCAUGHT_ERROR" : "UNCAUGHT_" + sb;
    }

    // =========================================================================
    // Internal map helpers
    // =========================================================================

    private static object? PickFirst(IDictionary<string, object?> m, params string[] keys)
    {
        foreach (var k in keys)
        {
            if (m.TryGetValue(k, out var v)) return v;
        }
        return null;
    }

    private static bool TryGetInt(IDictionary<string, object?> m, out int value, params string[] keys)
    {
        var raw = PickFirst(m, keys);
        switch (raw)
        {
            case int i: value = i; return true;
            case long l: value = (int)l; return true;
            case double d: value = (int)d; return true;
            case JsonElement el when el.ValueKind == JsonValueKind.Number:
                value = el.GetInt32();
                return true;
            default:
                value = 0;
                return false;
        }
    }

    private static bool TryGetLong(IDictionary<string, object?> m, out long value, params string[] keys)
    {
        var raw = PickFirst(m, keys);
        switch (raw)
        {
            case int i: value = i; return true;
            case long l: value = l; return true;
            case double d: value = (long)d; return true;
            case JsonElement el when el.ValueKind == JsonValueKind.Number:
                value = el.GetInt64();
                return true;
            default:
                value = 0;
                return false;
        }
    }

    private static Dictionary<string, object?> AsStringKeyMap(System.Collections.IDictionary raw)
    {
        var typed = new Dictionary<string, object?>();
        foreach (System.Collections.DictionaryEntry e in raw)
        {
            typed[e.Key.ToString() ?? ""] = e.Value;
        }
        return typed;
    }

    // =========================================================================
    // Builder
    // =========================================================================

    /// <summary>
    /// Fluent builder per master plan §17.5. Each setter returns
    /// <c>this</c> so chained calls compose without intermediate variables.
    /// Call <see cref="Build"/> to finalize.
    /// </summary>
    public sealed class Builder
    {
        internal readonly BlokErrorCategory CategoryValue;
        internal BlokErrorSeverity SeverityValue = BlokErrorSeverity.Error;
        internal string? CodeValue;
        internal string? MessageValue;
        internal string? DescriptionValue;
        internal string? RemediationValue;
        internal string? DocUrlValue;
        internal int HttpStatusValue;
        internal bool RetryableValue;
        internal long RetryAfterMsValue;
        internal object? DetailsValue;
        internal object? ContextSnapshotValue;
        internal Exception? CauseValue;
        internal List<Dictionary<string, object?>>? CausesValue;
        internal string? StackValue;
        internal DateTime? AtValue;
        internal string? NodeValue;
        internal string? SdkValue;
        internal string? SdkVersionValue;
        internal string? RuntimeKindValue;

        internal Builder(BlokErrorCategory category)
        {
            CategoryValue = category;
            HttpStatusValue = category.DefaultHttpStatus();
            RetryableValue = category.DefaultRetryable();
        }

        public Builder Code(string value) { CodeValue = value; return this; }
        public Builder Message(string value) { MessageValue = value; return this; }
        public Builder Description(string value) { DescriptionValue = value; return this; }
        public Builder Remediation(string value) { RemediationValue = value; return this; }
        public Builder DocUrl(string value) { DocUrlValue = value; return this; }
        public Builder HttpStatus(int value) { HttpStatusValue = value; return this; }
        public Builder Severity(BlokErrorSeverity value) { SeverityValue = value; return this; }
        public Builder Retryable(bool value) { RetryableValue = value; return this; }
        public Builder RetryAfter(TimeSpan duration) { RetryAfterMsValue = (long)duration.TotalMilliseconds; return this; }
        public Builder RetryAfterMs(long value) { RetryAfterMsValue = value; return this; }
        public Builder Details(object? value) { DetailsValue = value; return this; }
        public Builder ContextSnapshot(object? value) { ContextSnapshotValue = value; return this; }
        public Builder Cause(Exception? value) { CauseValue = value; return this; }
        public Builder Causes(List<Dictionary<string, object?>> value) { CausesValue = value; return this; }
        public Builder Stack(string value) { StackValue = value; return this; }
        public Builder At(DateTime value) { AtValue = value; return this; }
        public Builder Node(string value) { NodeValue = value; return this; }
        public Builder Sdk(string value) { SdkValue = value; return this; }
        public Builder SdkVersion(string value) { SdkVersionValue = value; return this; }
        public Builder RuntimeKind(string value) { RuntimeKindValue = value; return this; }

        /// <summary>
        /// Apply origin fields, only filling unset ones. Use this in the
        /// runtime-side wrapping path; explicit handler-set values win.
        /// </summary>
        public Builder ApplyOrigin(BlokErrorOrigin origin)
        {
            if (string.IsNullOrEmpty(NodeValue)) NodeValue = origin.Node;
            if (string.IsNullOrEmpty(SdkValue)) SdkValue = origin.Sdk;
            if (string.IsNullOrEmpty(SdkVersionValue)) SdkVersionValue = origin.SdkVersion;
            if (string.IsNullOrEmpty(RuntimeKindValue)) RuntimeKindValue = origin.RuntimeKind;
            return this;
        }

        public BlokError Build() => new(this);
    }
}

/// <summary>
/// Carrier of the auto-enrichment fields the gRPC servicer fills into a
/// handler-thrown <see cref="BlokError"/> when the handler didn't set those
/// fields explicitly.
/// </summary>
public record BlokErrorOrigin(string Node, string Sdk, string SdkVersion, string RuntimeKind)
{
    /// <summary>
    /// Build an <see cref="BlokErrorOrigin"/> populated with the SDK
    /// constants (<see cref="BlokError.DefaultSdkName"/>,
    /// <see cref="BlokError.DefaultRuntimeKind"/>) and the caller-provided
    /// node name + SDK version.
    /// </summary>
    public static BlokErrorOrigin Defaults(string node, string sdkVersion)
        => new(node ?? string.Empty, BlokError.DefaultSdkName, sdkVersion ?? string.Empty, BlokError.DefaultRuntimeKind);
}
