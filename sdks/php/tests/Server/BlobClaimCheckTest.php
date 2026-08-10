<?php

declare(strict_types=1);

namespace Blok\Blok\Tests\Server;

use Blok\Blok\Server\BlokNodeRuntimeService;
use Blok\Blok\Server\DecodeException;
use PHPUnit\Framework\TestCase;

/**
 * ADR 0014 — claim-check ($blokBlob) resolution.
 *
 * The runner replaces oversized `inputs` with a sentinel; we read it back.
 * These cover the trust boundary: the id arrives over the wire, so anything
 * that could escape BLOK_BLOB_DIR must be refused before we open a file.
 */
final class BlobClaimCheckTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/blok-blob-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0777, true);
        putenv('BLOK_BLOB_DIR=' . $this->dir);
    }

    protected function tearDown(): void
    {
        putenv('BLOK_BLOB_DIR');
        // Best-effort cleanup; the OS reaps the temp dir either way.
        foreach (glob($this->dir . '/*/*') ?: [] as $file) {
            @unlink($file);
        }
        foreach (glob($this->dir . '/*') ?: [] as $sub) {
            @rmdir($sub);
        }
        @rmdir($this->dir);
    }

    /** @param array<string, mixed> $payload @return array<string, mixed> */
    private function writeBlob(string $runId, array $payload): array
    {
        mkdir($this->dir . '/' . $runId, 0777, true);
        $json = (string) json_encode($payload);
        file_put_contents($this->dir . '/' . $runId . '/blob.json', $json);

        return ['$blokBlob' => ['id' => $runId . '/blob.json', 'bytes' => strlen($json), 'codec' => 'json']];
    }

    public function testResolvesSentinelToTheReferencedPayload(): void
    {
        $payload = ['symbols' => ['a', 'b']];
        $ref = $this->writeBlob('run_1', $payload);

        self::assertSame($payload, BlokNodeRuntimeService::resolveInputBlob($ref));
    }

    public function testOrdinaryInputsPassThroughUntouched(): void
    {
        self::assertSame(['msg' => 'ping'], BlokNodeRuntimeService::resolveInputBlob(['msg' => 'ping']));

        // A sentinel-shaped key alongside real fields is NOT a claim-check.
        $mixed = ['$blokBlob' => ['id' => 'a/b'], 'other' => 1];
        self::assertSame($mixed, BlokNodeRuntimeService::resolveInputBlob($mixed));
    }

    public function testRefusesARefWhenBlobDirIsNotConfigured(): void
    {
        $ref = $this->writeBlob('run_3', ['a' => 1]);
        putenv('BLOK_BLOB_DIR');

        $this->expectException(DecodeException::class);
        $this->expectExceptionMessageMatches('/BLOK_BLOB_DIR/');
        BlokNodeRuntimeService::resolveInputBlob($ref);
    }

    /** @return list<array{mixed}> */
    public static function escapingIds(): array
    {
        return [
            ['../../etc/passwd'],
            ['run_1/../../etc/passwd'],
            ['/etc/passwd'],
            ['passwd'],
            ['.ssh/id_rsa'],
            [42],
            [null],
        ];
    }

    /** @dataProvider escapingIds */
    public function testRefusesIdsThatCouldEscapeTheBlobDir(mixed $blobId): void
    {
        $this->expectException(DecodeException::class);
        $this->expectExceptionMessageMatches('/invalid \$blokBlob id/');
        BlokNodeRuntimeService::resolveInputBlob(
            ['$blokBlob' => ['id' => $blobId, 'bytes' => 1, 'codec' => 'json']]
        );
    }

    public function testReportsAMissingBlobInsteadOfCrashing(): void
    {
        $this->expectException(DecodeException::class);
        $this->expectExceptionMessageMatches('/cannot read blob/');
        BlokNodeRuntimeService::resolveInputBlob(
            ['$blokBlob' => ['id' => 'run_x/gone.json', 'bytes' => 1, 'codec' => 'json']]
        );
    }

    // The runner sends a claim-check ref ONLY to a runtime that says it can
    // resolve one, so this advertisement is the whole capability gate.
    public function testAdvertisesBlobCapabilityOnlyWhenConfigured(): void
    {
        self::assertSame(['blob-v1'], BlokNodeRuntimeService::blobCapabilities());

        putenv('BLOK_BLOB_DIR');
        self::assertSame([], BlokNodeRuntimeService::blobCapabilities());
    }
}
