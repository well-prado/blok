using System.Text.Json;
using Blok.Core.Server;
using FluentAssertions;
using Xunit;

namespace Blok.Core.Tests.Server;

/// <summary>
/// ADR 0014 — claim-check ($blokBlob) resolution.
///
/// The runner replaces oversized <c>inputs</c> with a sentinel; we read it
/// back. These cover the trust boundary: the id arrives over the wire, so
/// anything that could escape BLOK_BLOB_DIR must be refused before we open a
/// file.
/// </summary>
public class BlobClaimCheckTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"blok-blob-{Guid.NewGuid():N}");

    public BlobClaimCheckTests()
    {
        Directory.CreateDirectory(_dir);
        Environment.SetEnvironmentVariable("BLOK_BLOB_DIR", _dir);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("BLOK_BLOB_DIR", null);
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { /* best effort */ }
        GC.SuppressFinalize(this);
    }

    private Dictionary<string, JsonElement> WriteBlob(string runId, string payloadJson)
    {
        var runDir = Path.Combine(_dir, runId);
        Directory.CreateDirectory(runDir);
        File.WriteAllText(Path.Combine(runDir, "blob.json"), payloadJson);
        return Sentinel($"\"{runId}/blob.json\"", payloadJson.Length);
    }

    /// <param name="idJsonLiteral">The id as a raw JSON literal, so a test can
    /// send a non-string id the way the wire could.</param>
    private static Dictionary<string, JsonElement> Sentinel(string idJsonLiteral, int bytes)
        => Parse("{\"$blokBlob\":{\"id\":" + idJsonLiteral + ",\"bytes\":" + bytes + ",\"codec\":\"json\"}}");

    private static Dictionary<string, JsonElement> Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var map = new Dictionary<string, JsonElement>();
        foreach (var prop in doc.RootElement.EnumerateObject()) map[prop.Name] = prop.Value.Clone();
        return map;
    }

    [Fact]
    public void ResolvesSentinelToTheReferencedPayload()
    {
        var sentinel = WriteBlob("run_1", """{"symbols":["a","b"]}""");

        var resolved = BlokNodeRuntimeService.ResolveInputBlob(sentinel);

        resolved.Should().ContainKey("symbols");
        resolved["symbols"].GetArrayLength().Should().Be(2);
    }

    [Fact]
    public void OrdinaryInputsPassThroughUntouched()
    {
        var plain = Parse("""{"msg":"ping"}""");
        BlokNodeRuntimeService.ResolveInputBlob(plain).Should().BeSameAs(plain);

        // A sentinel-shaped key alongside real fields is NOT a claim-check.
        var mixed = Parse("""{"$blokBlob":{"id":"a/b"},"other":1}""");
        BlokNodeRuntimeService.ResolveInputBlob(mixed).Should().BeSameAs(mixed);
    }

    [Fact]
    public void RefusesARefWhenBlobDirIsNotConfigured()
    {
        var sentinel = WriteBlob("run_3", """{"a":1}""");
        Environment.SetEnvironmentVariable("BLOK_BLOB_DIR", null);

        var act = () => BlokNodeRuntimeService.ResolveInputBlob(sentinel);

        act.Should().Throw<BlokNodeRuntimeService.DecodeException>().WithMessage("*BLOK_BLOB_DIR*");
    }

    [Theory]
    [InlineData("\"../../etc/passwd\"")]
    [InlineData("\"run_1/../../etc/passwd\"")]
    [InlineData("\"/etc/passwd\"")]
    [InlineData("\"passwd\"")]
    [InlineData("\".ssh/id_rsa\"")]
    [InlineData("42")]
    [InlineData("null")]
    public void RefusesIdsThatCouldEscapeTheBlobDir(string idJsonLiteral)
    {
        var act = () => BlokNodeRuntimeService.ResolveInputBlob(Sentinel(idJsonLiteral, 1));

        act.Should().Throw<BlokNodeRuntimeService.DecodeException>().WithMessage("*invalid $blokBlob id*");
    }

    [Fact]
    public void ReportsAMissingBlobInsteadOfCrashing()
    {
        var act = () => BlokNodeRuntimeService.ResolveInputBlob(Sentinel("\"run_x/gone.json\"", 1));

        act.Should().Throw<BlokNodeRuntimeService.DecodeException>().WithMessage("*cannot read blob*");
    }

    // The runner sends a claim-check ref ONLY to a runtime that says it can
    // resolve one, so this advertisement is the whole capability gate.
    [Fact]
    public void AdvertisesBlobCapabilityOnlyWhenConfigured()
    {
        BlokNodeRuntimeService.BlobCapabilities().Should().Equal("blob-v1");

        Environment.SetEnvironmentVariable("BLOK_BLOB_DIR", null);
        BlokNodeRuntimeService.BlobCapabilities().Should().BeEmpty();
    }
}
