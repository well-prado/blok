using System.Text.Json;
using Blok.Core.Errors;
using FluentAssertions;
using Xunit;

namespace Blok.Core.Tests.Errors;

/// <summary>
/// Unit tests for the structured <see cref="BlokError"/> per master plan §17.
///
/// <para>Coverage parallels Python (<c>test_blok_error.py</c>), Go
/// (<c>blok_error_test.go</c>), Rust (<c>blok_error::tests</c>), and Java
/// (<c>BlokErrorTest</c>). Each SDK exhaustively tests the same API surface
/// so the cross-language wire shape stays in lockstep.</para>
/// </summary>
public class BlokErrorTests
{
    // ===== Category defaults =================================================

    [Fact]
    public void CategoryDefaultStatusMatchesTable()
    {
        BlokErrorCategory.Validation.DefaultHttpStatus().Should().Be(400);
        BlokErrorCategory.Configuration.DefaultHttpStatus().Should().Be(500);
        BlokErrorCategory.Dependency.DefaultHttpStatus().Should().Be(502);
        BlokErrorCategory.Timeout.DefaultHttpStatus().Should().Be(504);
        BlokErrorCategory.Permission.DefaultHttpStatus().Should().Be(403);
        BlokErrorCategory.RateLimit.DefaultHttpStatus().Should().Be(429);
        BlokErrorCategory.NotFound.DefaultHttpStatus().Should().Be(404);
        BlokErrorCategory.Conflict.DefaultHttpStatus().Should().Be(409);
        BlokErrorCategory.Cancelled.DefaultHttpStatus().Should().Be(499);
        BlokErrorCategory.Internal.DefaultHttpStatus().Should().Be(500);
        BlokErrorCategory.Protocol.DefaultHttpStatus().Should().Be(502);
        BlokErrorCategory.Data.DefaultHttpStatus().Should().Be(422);
    }

    [Fact]
    public void CategoryDefaultRetryableMatchesTable()
    {
        BlokErrorCategory.Dependency.DefaultRetryable().Should().BeTrue();
        BlokErrorCategory.Timeout.DefaultRetryable().Should().BeTrue();
        BlokErrorCategory.RateLimit.DefaultRetryable().Should().BeTrue();
        BlokErrorCategory.Validation.DefaultRetryable().Should().BeFalse();
        BlokErrorCategory.Internal.DefaultRetryable().Should().BeFalse();
        BlokErrorCategory.Conflict.DefaultRetryable().Should().BeFalse();
    }

    [Fact]
    public void CategoryParseUnknownFallsBackToInternal()
    {
        BlokErrorCategoryExtensions.Parse("DEPENDENCY").Should().Be(BlokErrorCategory.Dependency);
        BlokErrorCategoryExtensions.Parse("not-a-thing").Should().Be(BlokErrorCategory.Internal);
        BlokErrorCategoryExtensions.Parse(null).Should().Be(BlokErrorCategory.Internal);
    }

    [Fact]
    public void CategoryAsWireRoundTrips()
    {
        foreach (BlokErrorCategory cat in Enum.GetValues<BlokErrorCategory>())
        {
            BlokErrorCategoryExtensions.Parse(cat.AsWire()).Should().Be(cat);
        }
    }

    [Fact]
    public void SeverityParseFallsBackToError()
    {
        BlokErrorSeverityExtensions.Parse("INFO").Should().Be(BlokErrorSeverity.Info);
        BlokErrorSeverityExtensions.Parse("xyz").Should().Be(BlokErrorSeverity.Error);
        BlokErrorSeverityExtensions.Parse(null).Should().Be(BlokErrorSeverity.Error);
    }

    // ===== Builder ===========================================================

    [Fact]
    public void BuilderDependencyDefaults()
    {
        var e = BlokError.Dependency().Code("X").Message("y").Build();
        e.Category.Should().Be(BlokErrorCategory.Dependency);
        e.HttpStatus.Should().Be(502);
        e.Retryable.Should().BeTrue();
        e.Severity.Should().Be(BlokErrorSeverity.Error);
    }

    [Fact]
    public void BuilderValidationDefaults()
    {
        var e = BlokError.Validation().Code("V").Message("v").Build();
        e.Category.Should().Be(BlokErrorCategory.Validation);
        e.HttpStatus.Should().Be(400);
        e.Retryable.Should().BeFalse();
    }

    [Fact]
    public void BuilderOverridesTakePriority()
    {
        var e = BlokError.Dependency()
            .HttpStatus(599)
            .Retryable(false)
            .Severity(BlokErrorSeverity.Fatal)
            .Build();
        e.HttpStatus.Should().Be(599);
        e.Retryable.Should().BeFalse();
        e.Severity.Should().Be(BlokErrorSeverity.Fatal);
    }

    [Fact]
    public void BuilderRetryAfterTimeSpanToMs()
    {
        var e = BlokError.RateLimit().RetryAfter(TimeSpan.FromSeconds(5)).Build();
        e.RetryAfterMs.Should().Be(5_000);
    }

    [Fact]
    public void BuilderRetryAfterMsDirect()
    {
        var e = BlokError.Timeout().RetryAfterMs(750L).Build();
        e.RetryAfterMs.Should().Be(750L);
    }

    [Fact]
    public void BuilderDetailsRoundTrip()
    {
        var details = new Dictionary<string, object?>
        {
            ["issues"] = new List<Dictionary<string, object?>>
            {
                new() { ["path"] = new List<string> { "email" } },
            },
        };
        var e = BlokError.Validation().Details(details).Build();
        var actual = e.Details as Dictionary<string, object?>;
        actual.Should().NotBeNull();
        actual![ "issues"].Should().NotBeNull();
    }

    [Fact]
    public void BuilderCausePopulatesCausesList()
    {
        var io = new IOException("nope");
        var e = BlokError.Dependency().Cause(io).Build();
        e.Causes.Should().NotBeEmpty();
        e.Causes[0]["category"].Should().Be("INTERNAL");
        e.Causes[0]["message"].Should().Be("nope");
    }

    [Fact]
    public void BuilderApplyOriginFillsOnlyMissing()
    {
        var origin = BlokErrorOrigin.Defaults("my-node", "1.2.3");
        var e = BlokError.Dependency().Sdk("custom").ApplyOrigin(origin).Build();
        e.Sdk.Should().Be("custom");
        e.Node.Should().Be("my-node");
        e.SdkVersion.Should().Be("1.2.3");
        e.RuntimeKind.Should().Be("runtime.csharp");
    }

    [Fact]
    public void AllTwelveCategoryFactoriesProduceCorrectCategory()
    {
        BlokError.Validation().Build().Category.Should().Be(BlokErrorCategory.Validation);
        BlokError.Configuration().Build().Category.Should().Be(BlokErrorCategory.Configuration);
        BlokError.Dependency().Build().Category.Should().Be(BlokErrorCategory.Dependency);
        BlokError.Timeout().Build().Category.Should().Be(BlokErrorCategory.Timeout);
        BlokError.Permission().Build().Category.Should().Be(BlokErrorCategory.Permission);
        BlokError.RateLimit().Build().Category.Should().Be(BlokErrorCategory.RateLimit);
        BlokError.NotFound().Build().Category.Should().Be(BlokErrorCategory.NotFound);
        BlokError.Conflict().Build().Category.Should().Be(BlokErrorCategory.Conflict);
        BlokError.Cancelled().Build().Category.Should().Be(BlokErrorCategory.Cancelled);
        BlokError.Internal().Build().Category.Should().Be(BlokErrorCategory.Internal);
        BlokError.Protocol().Build().Category.Should().Be(BlokErrorCategory.Protocol);
        BlokError.Data().Build().Category.Should().Be(BlokErrorCategory.Data);
    }

    [Fact]
    public void OfProducesGenericFactory()
    {
        var e = BlokError.Of(BlokErrorCategory.Data).Code("x").Message("y").Build();
        e.Category.Should().Be(BlokErrorCategory.Data);
        e.HttpStatus.Should().Be(422);
    }

    // ===== FromUnknown =======================================================

    [Fact]
    public void FromUnknownPassesThroughTypedBlokError()
    {
        var origin = BlokErrorOrigin.Defaults("auto-node", "1.2.3");
        var original = BlokError.RateLimit().Code("UPSTREAM_RATE_LIMITED").Message("limit hit").Build();
        var recovered = BlokError.FromUnknown(original, origin);
        recovered.Should().BeSameAs(original);
        // Origin auto-enrichment kicked in.
        recovered.Node.Should().Be("auto-node");
        recovered.SdkVersion.Should().Be("1.2.3");
        recovered.Category.Should().Be(BlokErrorCategory.RateLimit);
    }

    [Fact]
    public void FromUnknownWrapsThrowable()
    {
        var origin = BlokErrorOrigin.Defaults("auto", "1.0.0");
        var cause = new IOException("disk full");
        var wrapped = BlokError.FromUnknown(cause, origin);
        wrapped.Category.Should().Be(BlokErrorCategory.Internal);
        wrapped.Message.Should().Be("disk full");
        wrapped.Code.Should().StartWith("UNCAUGHT_");
    }

    [Fact]
    public void FromUnknownWrapsString()
    {
        var wrapped = BlokError.FromUnknown("boom", BlokErrorOrigin.Defaults("x", "1.0.0"));
        wrapped.Category.Should().Be(BlokErrorCategory.Internal);
        wrapped.Message.Should().Be("boom");
        wrapped.Code.Should().Be("UNCAUGHT_ERROR");
        var details = wrapped.Details as Dictionary<string, object?>;
        details!["message"].Should().Be("boom");
    }

    [Fact]
    public void FromUnknownWrapsMap()
    {
        var raw = new Dictionary<string, object?>
        {
            ["message"] = "from-map",
            ["custom"] = 42,
        };
        var wrapped = BlokError.FromUnknown(raw, BlokErrorOrigin.Defaults("x", "1.0.0"));
        wrapped.Message.Should().Be("from-map");
        wrapped.Category.Should().Be(BlokErrorCategory.Internal);
        var details = wrapped.Details as Dictionary<string, object?>;
        details!["custom"].Should().Be(42);
    }

    [Fact]
    public void FromUnknownHandlesNull()
    {
        var wrapped = BlokError.FromUnknown(null, BlokErrorOrigin.Defaults("x", "1.0.0"));
        wrapped.Message.Should().Be("node error");
        wrapped.Category.Should().Be(BlokErrorCategory.Internal);
    }

    [Fact]
    public void FromUnknownWrapsLegacyNodeException()
    {
        var origin = BlokErrorOrigin.Defaults("x", "1.0.0");
        var legacy = NodeException.Network("postgres unreachable");
        var wrapped = BlokError.FromUnknown(legacy, origin);
        wrapped.Category.Should().Be(BlokErrorCategory.Internal);
        wrapped.Code.Should().Be("UNCAUGHT_NODEEXCEPTION");
        wrapped.Message.Should().Contain("postgres unreachable");
        wrapped.Details.Should().NotBeNull();
    }

    // ===== ToMap / FromMap ===================================================

    [Fact]
    public void ToMapAndFromMapRoundTrip()
    {
        var details = new Dictionary<string, object?> { ["a"] = 1 };
        var e = BlokError.Dependency()
            .Code("CODE")
            .Message("msg")
            .Description("desc")
            .Remediation("rem")
            .DocUrl("https://example.com")
            .Retryable(true)
            .RetryAfterMs(1234L)
            .Details(details)
            .Node("n")
            .Sdk("blok-csharp")
            .SdkVersion("1.0.0")
            .RuntimeKind("runtime.csharp")
            .Build();

        var map = e.ToMap();
        map["category"].Should().Be("DEPENDENCY");
        map["code"].Should().Be("CODE");
        map["http_status"].Should().Be(502);
        map["retry_after_ms"].Should().Be(1234L);

        var restored = BlokError.FromMap(map);
        restored.Category.Should().Be(BlokErrorCategory.Dependency);
        restored.Code.Should().Be("CODE");
        restored.Message.Should().Be("msg");
        restored.Description.Should().Be("desc");
        restored.RetryAfterMs.Should().Be(1234L);
        restored.DocUrl.Should().Be("https://example.com");
    }

    [Fact]
    public void FromMapAcceptsCamelCaseKeys()
    {
        var raw = new Dictionary<string, object?>
        {
            ["category"] = "RATE_LIMIT",
            ["severity"] = "ERROR",
            ["code"] = "RL",
            ["message"] = "too many",
            ["httpStatus"] = 429,
            ["retryable"] = true,
            ["retryAfterMs"] = 60_000L,
            ["at"] = "2026-04-29T00:00:00Z",
            ["sdkVersion"] = "1.0.0",
            ["runtimeKind"] = "runtime.csharp",
            ["docUrl"] = "https://docs/example",
        };
        var e = BlokError.FromMap(raw);
        e.Category.Should().Be(BlokErrorCategory.RateLimit);
        e.HttpStatus.Should().Be(429);
        e.RetryAfterMs.Should().Be(60_000L);
        e.SdkVersion.Should().Be("1.0.0");
        e.RuntimeKind.Should().Be("runtime.csharp");
        e.DocUrl.Should().Be("https://docs/example");
    }

    [Fact]
    public void FromMapAcceptsCausesList()
    {
        var raw = new Dictionary<string, object?>
        {
            ["category"] = "DEPENDENCY",
            ["severity"] = "ERROR",
            ["code"] = "X",
            ["message"] = "y",
            ["causes"] = new List<Dictionary<string, object?>>
            {
                new() { ["message"] = "inner", ["category"] = "INTERNAL" },
            },
        };
        var e = BlokError.FromMap(raw);
        e.Causes.Should().HaveCount(1);
        e.Causes[0]["message"].Should().Be("inner");
    }

    // ===== Display / Exception semantics =====================================

    [Fact]
    public void ToStringFormatsCategoryAndMessage()
    {
        var e = BlokError.Dependency().Code("X").Message("nope").Build();
        e.ToString().Should().Be("[DEPENDENCY] nope");
    }

    [Fact]
    public void CanBeThrownAsException()
    {
        var e = BlokError.Timeout().Code("X").Message("y").Build();
        Action act = () => throw e;
        act.Should().Throw<BlokError>();
    }

    // ===== UncaughtCode derivation ===========================================

    [Fact]
    public void UncaughtCodeStripsAndUppercasesSimpleName()
    {
        BlokError.UncaughtCode(typeof(IOException)).Should().Be("UNCAUGHT_IOEXCEPTION");
        BlokError.UncaughtCode(typeof(BlokError)).Should().Be("UNCAUGHT_BLOKERROR");
        BlokError.UncaughtCode(null).Should().Be("UNCAUGHT_ERROR");
    }

    // ===== Cause-chain flattening ===========================================

    [Fact]
    public void FlattenCausesWalksInnerExceptionChain()
    {
        var inner = new IOException("inner");
        var wrap = new InvalidOperationException("wrapped", inner);
        var causes = BlokError.FlattenCauses(wrap);
        causes.Should().HaveCount(2);
        causes[0]["message"].Should().Be("wrapped");
        causes[1]["message"].Should().Be("inner");
    }

    [Fact]
    public void FlattenCausesLiftsBlokErrorLink()
    {
        var inner = BlokError.NotFound().Code("INNER").Message("inner-msg").Build();
        var causes = BlokError.FlattenCauses(inner);
        causes[0]["code"].Should().Be("INNER");
        causes[0]["category"].Should().Be("NOT_FOUND");
    }

    // ===== BuildContextSnapshot ==============================================

    [Fact]
    public void SnapshotPreservesSmallPayload()
    {
        var inputs = new Dictionary<string, object?> { ["a"] = 1 };
        var vars = new Dictionary<string, object?> { ["k1"] = "v1" };
        var snap = BuildContextSnapshot.Of(inputs, vars);
        ((Dictionary<string, object?>)snap["inputs"]!)["a"].Should().Be(1);
        ((Dictionary<string, object?>)snap["vars"]!)["k1"].Should().Be("v1");
    }

    [Fact]
    public void SnapshotCapsAtMaxBytes()
    {
        var inputs = new Dictionary<string, object?>();
        var vars = new Dictionary<string, object?>();
        var filler = new string('x', 100);
        for (int i = 0; i < 80; i++)
        {
            vars[$"k{i:D3}"] = filler;
        }
        var snap = BuildContextSnapshot.Of(inputs, vars);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(snap).Length;
        bytes.Should().BeLessThanOrEqualTo(BlokError.ContextSnapshotMaxBytes + 64);
    }

    [Fact]
    public void SnapshotKeepsLastNKeys()
    {
        var inputs = new Dictionary<string, object?>();
        var vars = new Dictionary<string, object?>();
        for (int i = 0; i < 32; i++)
        {
            vars[$"k{i:D2}"] = i;
        }
        var snap = BuildContextSnapshot.Of(inputs, vars, 0, 5);
        var kept = (Dictionary<string, object?>)snap["vars"]!;
        kept.Should().HaveCount(5);
        kept.Should().ContainKey("k31");
        kept.Should().NotContainKey("k00");
    }

    [Fact]
    public void SnapshotDisablesVarKeysWhenZero()
    {
        var inputs = new Dictionary<string, object?>();
        var vars = new Dictionary<string, object?> { ["only"] = 1 };
        var snap = BuildContextSnapshot.Of(inputs, vars, 0, 0);
        ((Dictionary<string, object?>)snap["vars"]!).Should().BeEmpty();
    }

    // ===== Origin ============================================================

    [Fact]
    public void OriginDefaultsUsesSdkConstants()
    {
        var origin = BlokErrorOrigin.Defaults("n", "1.2.3");
        origin.Sdk.Should().Be(BlokError.DefaultSdkName);
        origin.RuntimeKind.Should().Be(BlokError.DefaultRuntimeKind);
        origin.Node.Should().Be("n");
        origin.SdkVersion.Should().Be("1.2.3");
    }

    [Fact]
    public void ApplyOriginIfMissingPreservesExplicitFields()
    {
        var e = BlokError.Internal().Node("explicit").Build();
        e.ApplyOriginIfMissing(BlokErrorOrigin.Defaults("auto", "1.0.0"));
        e.Node.Should().Be("explicit");
        e.Sdk.Should().Be(BlokError.DefaultSdkName);
        e.RuntimeKind.Should().Be(BlokError.DefaultRuntimeKind);
    }
}
