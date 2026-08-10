package com.blok.blok.server;

import com.google.gson.Gson;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ADR 0014 — claim-check ($blokBlob) resolution.
 *
 * <p>The runner replaces oversized {@code inputs} with a sentinel; we read it
 * back. These cover the trust boundary: the id arrives over the wire, so
 * anything that could escape BLOK_BLOB_DIR must be refused before we open a
 * file.
 */
class BlobClaimCheckTest {

    private static final Gson GSON = new Gson();

    private static Map<String, Object> writeBlob(Path root, String runId, Map<String, Object> payload)
            throws IOException {
        Path runDir = root.resolve(runId);
        Files.createDirectories(runDir);
        String json = GSON.toJson(payload);
        Files.writeString(runDir.resolve("blob.json"), json);
        Map<String, Object> ref = new HashMap<>();
        ref.put("id", runId + "/blob.json");
        ref.put("bytes", (double) json.length());
        ref.put("codec", "json");
        return Map.of("$blokBlob", ref);
    }

    @Test
    void resolvesSentinelToTheReferencedPayload(@TempDir Path tmp) throws Exception {
        Map<String, Object> payload = Map.of("symbols", List.of("a", "b"));
        Map<String, Object> ref = writeBlob(tmp, "run_1", payload);

        Map<String, Object> resolved =
                BlokNodeRuntimeService.resolveInputBlob(ref, tmp.toString());

        assertEquals(List.of("a", "b"), resolved.get("symbols"));
    }

    @Test
    void ordinaryInputsPassThroughUntouched(@TempDir Path tmp) throws Exception {
        Map<String, Object> plain = Map.of("msg", "ping");
        assertEquals(plain, BlokNodeRuntimeService.resolveInputBlob(plain, tmp.toString()));

        // A sentinel-shaped key alongside real fields is NOT a claim-check.
        Map<String, Object> mixed = Map.of("$blokBlob", Map.of("id", "a/b"), "other", 1);
        assertEquals(mixed, BlokNodeRuntimeService.resolveInputBlob(mixed, tmp.toString()));
    }

    @Test
    void refusesARefWhenBlobDirIsNotConfigured(@TempDir Path tmp) throws Exception {
        Map<String, Object> ref = writeBlob(tmp, "run_3", Map.of("a", 1));

        BlokNodeRuntimeService.DecodeException ex = assertThrows(
                BlokNodeRuntimeService.DecodeException.class,
                () -> BlokNodeRuntimeService.resolveInputBlob(ref, null));
        assertTrue(ex.getMessage().contains("BLOK_BLOB_DIR"), ex.getMessage());
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"../../etc/passwd", "run_1/../../etc/passwd", "/etc/passwd", "passwd", ".ssh/id_rsa"})
    void refusesIdsThatCouldEscapeTheBlobDir(String blobId, @TempDir Path tmp) {
        Map<String, Object> ref = new HashMap<>();
        ref.put("id", blobId);
        ref.put("bytes", 1);
        ref.put("codec", "json");

        BlokNodeRuntimeService.DecodeException ex = assertThrows(
                BlokNodeRuntimeService.DecodeException.class,
                () -> BlokNodeRuntimeService.resolveInputBlob(Map.of("$blokBlob", ref), tmp.toString()));
        assertTrue(ex.getMessage().contains("invalid $blokBlob id"), ex.getMessage());
    }

    @Test
    void refusesANonStringId(@TempDir Path tmp) {
        Map<String, Object> ref = Map.of("id", 42, "bytes", 1, "codec", "json");

        BlokNodeRuntimeService.DecodeException ex = assertThrows(
                BlokNodeRuntimeService.DecodeException.class,
                () -> BlokNodeRuntimeService.resolveInputBlob(Map.of("$blokBlob", ref), tmp.toString()));
        assertTrue(ex.getMessage().contains("invalid $blokBlob id"), ex.getMessage());
    }

    @Test
    void reportsAMissingBlobInsteadOfCrashing(@TempDir Path tmp) {
        Map<String, Object> ref = Map.of("id", "run_x/gone.json", "bytes", 1, "codec", "json");

        BlokNodeRuntimeService.DecodeException ex = assertThrows(
                BlokNodeRuntimeService.DecodeException.class,
                () -> BlokNodeRuntimeService.resolveInputBlob(Map.of("$blokBlob", ref), tmp.toString()));
        assertTrue(ex.getMessage().contains("cannot read blob"), ex.getMessage());
    }

    // The runner sends a claim-check ref ONLY to a runtime that says it can
    // resolve one, so this advertisement is the whole capability gate.
    @Test
    void advertisesBlobCapabilityOnlyWhenConfigured() {
        assertEquals(List.of(), BlokNodeRuntimeService.blobCapabilities(null));
        assertEquals(List.of("blob-v1"), BlokNodeRuntimeService.blobCapabilities("/tmp/blok-blobs"));
    }
}
