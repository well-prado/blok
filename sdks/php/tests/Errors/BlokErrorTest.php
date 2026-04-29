<?php

declare(strict_types=1);

namespace Blok\Blok\Tests\Errors;

use Blok\Blok\Errors\BlokError;
use Blok\Blok\Errors\BlokErrorCategory;
use Blok\Blok\Errors\BlokErrorSeverity;
use Blok\Blok\Errors\BuildContextSnapshot;
use Blok\Blok\Errors\NodeException;
use Blok\Blok\Errors\Origin;
use PHPUnit\Framework\TestCase;

/**
 * Unit tests for the structured {@see BlokError} per master plan §17.
 *
 * Coverage parallels Python (`test_blok_error.py`), Go (`blok_error_test.go`),
 * Rust (`blok_error::tests`), Java (`BlokErrorTest`), C# (`BlokErrorTests`),
 * and Ruby (`blok_error_test.rb`). Each SDK exhaustively tests the same API
 * surface so the cross-language wire shape stays in lockstep.
 */
final class BlokErrorTest extends TestCase
{
    // ===== Category defaults =================================================

    public function test_category_default_status_matches_table(): void
    {
        $this->assertSame(400, BlokErrorCategory::Validation->defaultHttpStatus());
        $this->assertSame(500, BlokErrorCategory::Configuration->defaultHttpStatus());
        $this->assertSame(502, BlokErrorCategory::Dependency->defaultHttpStatus());
        $this->assertSame(504, BlokErrorCategory::Timeout->defaultHttpStatus());
        $this->assertSame(403, BlokErrorCategory::Permission->defaultHttpStatus());
        $this->assertSame(429, BlokErrorCategory::RateLimit->defaultHttpStatus());
        $this->assertSame(404, BlokErrorCategory::NotFound->defaultHttpStatus());
        $this->assertSame(409, BlokErrorCategory::Conflict->defaultHttpStatus());
        $this->assertSame(499, BlokErrorCategory::Cancelled->defaultHttpStatus());
        $this->assertSame(500, BlokErrorCategory::Internal->defaultHttpStatus());
        $this->assertSame(502, BlokErrorCategory::Protocol->defaultHttpStatus());
        $this->assertSame(422, BlokErrorCategory::Data->defaultHttpStatus());
    }

    public function test_category_default_retryable_matches_table(): void
    {
        $this->assertTrue(BlokErrorCategory::Dependency->defaultRetryable());
        $this->assertTrue(BlokErrorCategory::Timeout->defaultRetryable());
        $this->assertTrue(BlokErrorCategory::RateLimit->defaultRetryable());
        $this->assertFalse(BlokErrorCategory::Validation->defaultRetryable());
        $this->assertFalse(BlokErrorCategory::Internal->defaultRetryable());
        $this->assertFalse(BlokErrorCategory::Conflict->defaultRetryable());
    }

    public function test_category_parse_unknown_falls_back_to_internal(): void
    {
        $this->assertSame(BlokErrorCategory::Dependency, BlokErrorCategory::parse('DEPENDENCY'));
        $this->assertSame(BlokErrorCategory::Internal,   BlokErrorCategory::parse('not-a-thing'));
        $this->assertSame(BlokErrorCategory::Internal,   BlokErrorCategory::parse(null));
    }

    public function test_severity_parse_falls_back_to_error(): void
    {
        $this->assertSame(BlokErrorSeverity::Info,  BlokErrorSeverity::parse('INFO'));
        $this->assertSame(BlokErrorSeverity::Error, BlokErrorSeverity::parse('xyz'));
        $this->assertSame(BlokErrorSeverity::Error, BlokErrorSeverity::parse(null));
    }

    // ===== Builder ===========================================================

    public function test_builder_dependency_defaults(): void
    {
        $e = BlokError::dependency()->code('X')->message('y')->build();
        $this->assertSame(BlokErrorCategory::Dependency, $e->category);
        $this->assertSame(502, $e->httpStatus);
        $this->assertTrue($e->retryable);
        $this->assertSame(BlokErrorSeverity::Error, $e->severity);
    }

    public function test_builder_validation_defaults(): void
    {
        $e = BlokError::validation()->code('V')->message('v')->build();
        $this->assertSame(BlokErrorCategory::Validation, $e->category);
        $this->assertSame(400, $e->httpStatus);
        $this->assertFalse($e->retryable);
    }

    public function test_builder_overrides_take_priority(): void
    {
        $e = BlokError::dependency()
            ->httpStatus(599)
            ->retryable(false)
            ->severity(BlokErrorSeverity::Fatal)
            ->build();
        $this->assertSame(599, $e->httpStatus);
        $this->assertFalse($e->retryable);
        $this->assertSame(BlokErrorSeverity::Fatal, $e->severity);
    }

    public function test_builder_retry_after_date_interval_to_ms(): void
    {
        $e = BlokError::rateLimit()->retryAfter(new \DateInterval('PT5S'))->build();
        $this->assertSame(5_000, $e->retryAfterMs);
    }

    public function test_builder_retry_after_ms_direct(): void
    {
        $e = BlokError::timeout()->retryAfterMs(750)->build();
        $this->assertSame(750, $e->retryAfterMs);
    }

    public function test_builder_details_round_trip(): void
    {
        $details = ['issues' => [['path' => ['email']]]];
        $e = BlokError::validation()->details($details)->build();
        $this->assertSame('email', $e->details['issues'][0]['path'][0]);
    }

    public function test_builder_cause_populates_causes_list(): void
    {
        $cause = new \RuntimeException('nope');
        $e = BlokError::dependency()->cause($cause)->build();
        $this->assertNotEmpty($e->causes);
        $this->assertSame('INTERNAL', $e->causes[0]['category']);
        $this->assertSame('nope', $e->causes[0]['message']);
    }

    public function test_builder_apply_origin_fills_only_missing(): void
    {
        $origin = Origin::defaults('my-node', '1.2.3');
        $e = BlokError::dependency()->sdk('custom')->applyOrigin($origin)->build();
        $this->assertSame('custom',       $e->sdk);          // explicit value preserved
        $this->assertSame('my-node',      $e->node);         // empty filled
        $this->assertSame('1.2.3',        $e->sdkVersion);
        $this->assertSame('runtime.php',  $e->runtimeKind);
    }

    public function test_all_twelve_category_factories_produce_correct_category(): void
    {
        $this->assertSame(BlokErrorCategory::Validation,    BlokError::validation()->build()->category);
        $this->assertSame(BlokErrorCategory::Configuration, BlokError::configuration()->build()->category);
        $this->assertSame(BlokErrorCategory::Dependency,    BlokError::dependency()->build()->category);
        $this->assertSame(BlokErrorCategory::Timeout,       BlokError::timeout()->build()->category);
        $this->assertSame(BlokErrorCategory::Permission,    BlokError::permission()->build()->category);
        $this->assertSame(BlokErrorCategory::RateLimit,     BlokError::rateLimit()->build()->category);
        $this->assertSame(BlokErrorCategory::NotFound,      BlokError::notFound()->build()->category);
        $this->assertSame(BlokErrorCategory::Conflict,      BlokError::conflict()->build()->category);
        $this->assertSame(BlokErrorCategory::Cancelled,     BlokError::cancelled()->build()->category);
        $this->assertSame(BlokErrorCategory::Internal,      BlokError::internal()->build()->category);
        $this->assertSame(BlokErrorCategory::Protocol,      BlokError::protocol()->build()->category);
        $this->assertSame(BlokErrorCategory::Data,          BlokError::data()->build()->category);
    }

    public function test_of_produces_generic_factory(): void
    {
        $e = BlokError::of(BlokErrorCategory::Data)->code('x')->message('y')->build();
        $this->assertSame(BlokErrorCategory::Data, $e->category);
        $this->assertSame(422, $e->httpStatus);
    }

    // ===== fromUnknown =======================================================

    public function test_from_unknown_passes_through_typed_blok_error(): void
    {
        $origin = Origin::defaults('auto-node', '1.2.3');
        $original = BlokError::rateLimit()->code('UPSTREAM_RATE_LIMITED')->message('limit hit')->build();
        $recovered = BlokError::fromUnknown($original, $origin);
        $this->assertSame($original, $recovered);
        $this->assertSame('auto-node', $recovered->node);
        $this->assertSame('1.2.3',     $recovered->sdkVersion);
        $this->assertSame(BlokErrorCategory::RateLimit, $recovered->category);
    }

    public function test_from_unknown_wraps_throwable(): void
    {
        $origin = Origin::defaults('auto', '1.0.0');
        $cause = new \RuntimeException('disk full');
        $wrapped = BlokError::fromUnknown($cause, $origin);
        $this->assertSame(BlokErrorCategory::Internal, $wrapped->category);
        $this->assertSame('disk full', $wrapped->getMessage());
        $this->assertStringStartsWith('UNCAUGHT_', $wrapped->errorCode);
    }

    public function test_from_unknown_wraps_string(): void
    {
        $wrapped = BlokError::fromUnknown('boom', Origin::defaults('x', '1.0.0'));
        $this->assertSame(BlokErrorCategory::Internal, $wrapped->category);
        $this->assertSame('boom', $wrapped->getMessage());
        $this->assertSame('UNCAUGHT_ERROR', $wrapped->errorCode);
        $this->assertSame('boom', $wrapped->details['message']);
    }

    public function test_from_unknown_wraps_array(): void
    {
        $raw = ['message' => 'from-map', 'custom' => 42];
        $wrapped = BlokError::fromUnknown($raw, Origin::defaults('x', '1.0.0'));
        $this->assertSame('from-map', $wrapped->getMessage());
        $this->assertSame(BlokErrorCategory::Internal, $wrapped->category);
        $this->assertSame(42, $wrapped->details['custom']);
    }

    public function test_from_unknown_handles_null(): void
    {
        $wrapped = BlokError::fromUnknown(null, Origin::defaults('x', '1.0.0'));
        $this->assertSame('node error', $wrapped->getMessage());
        $this->assertSame(BlokErrorCategory::Internal, $wrapped->category);
    }

    public function test_from_unknown_wraps_legacy_node_exception(): void
    {
        $legacy = NodeException::network('postgres unreachable');
        $wrapped = BlokError::fromUnknown($legacy, Origin::defaults('x', '1.0.0'));
        $this->assertSame(BlokErrorCategory::Internal, $wrapped->category);
        $this->assertSame('UNCAUGHT_NODEEXCEPTION', $wrapped->errorCode);
        $this->assertStringContainsString('postgres unreachable', $wrapped->getMessage());
        $this->assertNotNull($wrapped->details);
    }

    // ===== toArray / fromArray ===============================================

    public function test_to_array_and_from_array_round_trip(): void
    {
        $details = ['a' => 1];
        $e = BlokError::dependency()
            ->code('CODE')
            ->message('msg')
            ->description('desc')
            ->remediation('rem')
            ->docUrl('https://example.com')
            ->retryable(true)
            ->retryAfterMs(1234)
            ->details($details)
            ->node('n')
            ->sdk('blok-php')
            ->sdkVersion('1.0.0')
            ->runtimeKind('runtime.php')
            ->build();

        $array = $e->toArray();
        $this->assertSame('DEPENDENCY', $array['category']);
        $this->assertSame('CODE',       $array['code']);
        $this->assertSame(502,          $array['http_status']);
        $this->assertSame(1234,         $array['retry_after_ms']);

        $restored = BlokError::fromArray($array);
        $this->assertSame(BlokErrorCategory::Dependency, $restored->category);
        $this->assertSame('CODE',                $restored->errorCode);
        $this->assertSame('msg',                 $restored->getMessage());
        $this->assertSame('desc',                $restored->description);
        $this->assertSame(1234,                  $restored->retryAfterMs);
        $this->assertSame('https://example.com', $restored->docUrl);
    }

    public function test_from_array_accepts_camel_case_keys(): void
    {
        $raw = [
            'category'     => 'RATE_LIMIT',
            'severity'     => 'ERROR',
            'code'         => 'RL',
            'message'      => 'too many',
            'httpStatus'   => 429,
            'retryable'    => true,
            'retryAfterMs' => 60_000,
            'at'           => '2026-04-29T00:00:00+00:00',
            'sdkVersion'   => '1.0.0',
            'runtimeKind'  => 'runtime.php',
            'docUrl'       => 'https://docs/example',
        ];
        $e = BlokError::fromArray($raw);
        $this->assertSame(BlokErrorCategory::RateLimit, $e->category);
        $this->assertSame(429,                  $e->httpStatus);
        $this->assertSame(60_000,               $e->retryAfterMs);
        $this->assertSame('1.0.0',              $e->sdkVersion);
        $this->assertSame('runtime.php',        $e->runtimeKind);
        $this->assertSame('https://docs/example', $e->docUrl);
    }

    public function test_from_array_accepts_causes_list(): void
    {
        $raw = [
            'category' => 'DEPENDENCY',
            'severity' => 'ERROR',
            'code'     => 'X',
            'message'  => 'y',
            'causes'   => [
                ['message' => 'inner', 'category' => 'INTERNAL'],
            ],
        ];
        $e = BlokError::fromArray($raw);
        $this->assertCount(1, $e->causes);
        $this->assertSame('inner', $e->causes[0]['message']);
    }

    // ===== Display / Exception semantics =====================================

    public function test_to_string_formats_category_and_message(): void
    {
        $e = BlokError::dependency()->code('X')->message('nope')->build();
        $this->assertSame('[DEPENDENCY] nope', (string) $e);
    }

    public function test_can_be_thrown_as_exception(): void
    {
        $e = BlokError::timeout()->code('X')->message('y')->build();
        $this->expectException(BlokError::class);
        throw $e;
    }

    // ===== uncaught code derivation ==========================================

    public function test_uncaught_code_strips_namespace_and_uppercases(): void
    {
        $this->assertSame('UNCAUGHT_RUNTIMEEXCEPTION', BlokError::uncaughtCode(\RuntimeException::class));
        $this->assertSame('UNCAUGHT_BLOKERROR',         BlokError::uncaughtCode(BlokError::class));
        $this->assertSame('UNCAUGHT_ERROR',             BlokError::uncaughtCode(null));
        $this->assertSame('UNCAUGHT_ERROR',             BlokError::uncaughtCode(''));
    }

    // ===== cause-chain flattening ============================================

    public function test_flatten_causes_walks_get_previous_chain(): void
    {
        $inner = new \RuntimeException('inner');
        $wrap = new \LogicException('wrapped', 0, $inner);
        $causes = BlokError::flattenCauses($wrap);
        $this->assertCount(2, $causes);
        $this->assertSame('wrapped', $causes[0]['message']);
        $this->assertSame('inner',   $causes[1]['message']);
    }

    public function test_flatten_causes_lifts_blok_error_link(): void
    {
        $inner = BlokError::notFound()->code('INNER')->message('inner-msg')->build();
        $causes = BlokError::flattenCauses($inner);
        $this->assertSame('INNER',     $causes[0]['code']);
        $this->assertSame('NOT_FOUND', $causes[0]['category']);
    }

    // ===== BuildContextSnapshot ==============================================

    public function test_snapshot_preserves_small_payload(): void
    {
        $inputs = ['a' => 1];
        $vars = ['k1' => 'v1'];
        $snap = BuildContextSnapshot::of($inputs, $vars);
        $this->assertSame(1,    $snap['inputs']['a']);
        $this->assertSame('v1', $snap['vars']['k1']);
    }

    public function test_snapshot_caps_at_max_bytes(): void
    {
        $inputs = [];
        $vars = [];
        $filler = str_repeat('x', 100);
        for ($i = 0; $i < 80; $i++) {
            $vars[sprintf('k%03d', $i)] = $filler;
        }
        $snap = BuildContextSnapshot::of($inputs, $vars);
        $bytes = strlen(json_encode($snap, JSON_UNESCAPED_SLASHES) ?: '');
        $this->assertLessThanOrEqual(BlokError::CONTEXT_SNAPSHOT_MAX_BYTES + 64, $bytes);
    }

    public function test_snapshot_keeps_last_n_keys(): void
    {
        $inputs = [];
        $vars = [];
        for ($i = 0; $i < 32; $i++) {
            $vars[sprintf('k%02d', $i)] = $i;
        }
        $snap = BuildContextSnapshot::withOpts($inputs, $vars, 0, 5);
        $kept = $snap['vars'];
        $this->assertCount(5, $kept);
        $this->assertArrayHasKey('k31', $kept);
        $this->assertArrayNotHasKey('k00', $kept);
    }

    public function test_snapshot_disables_var_keys_when_zero(): void
    {
        $inputs = [];
        $vars = ['only' => 1];
        $snap = BuildContextSnapshot::withOpts($inputs, $vars, 0, 0);
        $this->assertEmpty($snap['vars']);
    }

    // ===== Origin ============================================================

    public function test_origin_defaults_uses_sdk_constants(): void
    {
        $o = Origin::defaults('n', '1.2.3');
        $this->assertSame(BlokError::DEFAULT_SDK_NAME,     $o->sdk);
        $this->assertSame(BlokError::DEFAULT_RUNTIME_KIND, $o->runtimeKind);
        $this->assertSame('n',     $o->node);
        $this->assertSame('1.2.3', $o->sdkVersion);
    }

    public function test_apply_origin_if_missing_preserves_explicit_fields(): void
    {
        $e = BlokError::internal()->code('X')->message('y')->node('explicit')->build();
        $e->applyOriginIfMissing(Origin::defaults('auto', '1.0.0'));
        $this->assertSame('explicit',                    $e->node);
        $this->assertSame(BlokError::DEFAULT_SDK_NAME,   $e->sdk);
        $this->assertSame(BlokError::DEFAULT_RUNTIME_KIND, $e->runtimeKind);
    }
}
