# frozen_string_literal: true

require_relative "../test_helper"
require "json"

# Unit tests for the structured +Blok::Errors::BlokError+ per master plan §17.
#
# Coverage parallels Python (+test_blok_error.py+), Go (+blok_error_test.go+),
# Rust (+blok_error::tests+), Java (+BlokErrorTest+), and C#
# (+BlokErrorTests+). Each SDK exhaustively tests the same API surface so
# the cross-language wire shape stays in lockstep.
class TestBlokError < Minitest::Test
  C  = Blok::Errors::BlokError::Category
  S  = Blok::Errors::BlokError::Severity
  BE = Blok::Errors::BlokError

  # ===== Category defaults =================================================

  def test_category_default_status_matches_table
    assert_equal 400, C::DEFAULT_HTTP_STATUS[C::VALIDATION]
    assert_equal 500, C::DEFAULT_HTTP_STATUS[C::CONFIGURATION]
    assert_equal 502, C::DEFAULT_HTTP_STATUS[C::DEPENDENCY]
    assert_equal 504, C::DEFAULT_HTTP_STATUS[C::TIMEOUT]
    assert_equal 403, C::DEFAULT_HTTP_STATUS[C::PERMISSION]
    assert_equal 429, C::DEFAULT_HTTP_STATUS[C::RATE_LIMIT]
    assert_equal 404, C::DEFAULT_HTTP_STATUS[C::NOT_FOUND]
    assert_equal 409, C::DEFAULT_HTTP_STATUS[C::CONFLICT]
    assert_equal 499, C::DEFAULT_HTTP_STATUS[C::CANCELLED]
    assert_equal 500, C::DEFAULT_HTTP_STATUS[C::INTERNAL]
    assert_equal 502, C::DEFAULT_HTTP_STATUS[C::PROTOCOL]
    assert_equal 422, C::DEFAULT_HTTP_STATUS[C::DATA]
  end

  def test_category_default_retryable_matches_table
    assert C::DEFAULT_RETRYABLE[C::DEPENDENCY]
    assert C::DEFAULT_RETRYABLE[C::TIMEOUT]
    assert C::DEFAULT_RETRYABLE[C::RATE_LIMIT]
    refute C::DEFAULT_RETRYABLE[C::VALIDATION]
    refute C::DEFAULT_RETRYABLE[C::INTERNAL]
    refute C::DEFAULT_RETRYABLE[C::CONFLICT]
  end

  def test_category_parse_unknown_falls_back_to_internal
    assert_equal C::DEPENDENCY, C.parse("DEPENDENCY")
    assert_equal C::INTERNAL,   C.parse("not-a-thing")
    assert_equal C::INTERNAL,   C.parse(nil)
  end

  def test_severity_parse_falls_back_to_error
    assert_equal S::INFO,  S.parse("INFO")
    assert_equal S::ERROR, S.parse("xyz")
    assert_equal S::ERROR, S.parse(nil)
  end

  # ===== Builder ===========================================================

  def test_builder_dependency_defaults
    e = BE.dependency(code: "X", message: "y")
    assert_equal C::DEPENDENCY, e.category
    assert_equal 502, e.http_status
    assert e.retryable
    assert_equal S::ERROR, e.severity
  end

  def test_builder_validation_defaults
    e = BE.validation(code: "V", message: "v")
    assert_equal C::VALIDATION, e.category
    assert_equal 400, e.http_status
    refute e.retryable
  end

  def test_builder_overrides_take_priority
    e = BE.dependency(code: "X", message: "y", http_status: 599, retryable: false, severity: S::FATAL)
    assert_equal 599, e.http_status
    refute e.retryable
    assert_equal S::FATAL, e.severity
  end

  def test_builder_retry_after_ms_direct
    e = BE.timeout(code: "T", message: "t", retry_after_ms: 750)
    assert_equal 750, e.retry_after_ms
  end

  def test_builder_details_round_trip
    details = { "issues" => [{ "path" => ["email"] }] }
    e = BE.validation(code: "V", message: "m", details: details)
    assert_equal "email", e.details["issues"][0]["path"][0]
  end

  def test_builder_cause_populates_causes_list
    cause = StandardError.new("nope")
    e = BE.dependency(code: "X", message: "y", cause: cause)
    refute_empty e.causes
    assert_equal "INTERNAL", e.causes[0]["category"]
    assert_equal "nope", e.causes[0]["message"]
  end

  def test_all_twelve_category_factories_produce_correct_category
    assert_equal C::VALIDATION,    BE.validation(code: "x", message: "y").category
    assert_equal C::CONFIGURATION, BE.configuration(code: "x", message: "y").category
    assert_equal C::DEPENDENCY,    BE.dependency(code: "x", message: "y").category
    assert_equal C::TIMEOUT,       BE.timeout(code: "x", message: "y").category
    assert_equal C::PERMISSION,    BE.permission(code: "x", message: "y").category
    assert_equal C::RATE_LIMIT,    BE.rate_limit(code: "x", message: "y").category
    assert_equal C::NOT_FOUND,     BE.not_found(code: "x", message: "y").category
    assert_equal C::CONFLICT,      BE.conflict(code: "x", message: "y").category
    assert_equal C::CANCELLED,     BE.cancelled(code: "x", message: "y").category
    assert_equal C::INTERNAL,      BE.internal(code: "x", message: "y").category
    assert_equal C::PROTOCOL,      BE.protocol(code: "x", message: "y").category
    assert_equal C::DATA,          BE.data(code: "x", message: "y").category
  end

  # ===== from_unknown ======================================================

  def test_from_unknown_passes_through_typed_blok_error
    origin = BE::Origin.defaults(node: "auto-node", sdk_version: "1.2.3")
    original = BE.rate_limit(code: "UPSTREAM_RATE_LIMITED", message: "limit hit")
    recovered = BE.from_unknown(original, origin: origin)
    assert_same original, recovered
    assert_equal "auto-node", recovered.node
    assert_equal "1.2.3", recovered.sdk_version
    assert_equal C::RATE_LIMIT, recovered.category
  end

  def test_from_unknown_wraps_throwable
    origin = BE::Origin.defaults(node: "auto", sdk_version: "1.0.0")
    cause = ArgumentError.new("disk full")
    wrapped = BE.from_unknown(cause, origin: origin)
    assert_equal C::INTERNAL, wrapped.category
    assert_equal "disk full", wrapped.message
    assert wrapped.code.start_with?("UNCAUGHT_")
  end

  def test_from_unknown_wraps_string
    origin = BE::Origin.defaults(node: "x", sdk_version: "1.0.0")
    wrapped = BE.from_unknown("boom", origin: origin)
    assert_equal C::INTERNAL, wrapped.category
    assert_equal "boom", wrapped.message
    assert_equal "UNCAUGHT_ERROR", wrapped.code
    assert_equal "boom", wrapped.details["message"]
  end

  def test_from_unknown_wraps_hash
    origin = BE::Origin.defaults(node: "x", sdk_version: "1.0.0")
    raw = { "message" => "from-map", "custom" => 42 }
    wrapped = BE.from_unknown(raw, origin: origin)
    assert_equal "from-map", wrapped.message
    assert_equal C::INTERNAL, wrapped.category
    assert_equal 42, wrapped.details["custom"]
  end

  def test_from_unknown_handles_nil
    origin = BE::Origin.defaults(node: "x", sdk_version: "1.0.0")
    wrapped = BE.from_unknown(nil, origin: origin)
    assert_equal "node error", wrapped.message
    assert_equal C::INTERNAL, wrapped.category
  end

  def test_from_unknown_wraps_legacy_node_error
    origin = BE::Origin.defaults(node: "x", sdk_version: "1.0.0")
    legacy = Blok::Errors::NodeError.network("postgres unreachable")
    wrapped = BE.from_unknown(legacy, origin: origin)
    assert_equal C::INTERNAL, wrapped.category
    assert_equal "UNCAUGHT_NODEERROR", wrapped.code
    assert_includes wrapped.message, "postgres unreachable"
    refute_nil wrapped.details
  end

  # ===== to_hash / from_hash ===============================================

  def test_to_hash_and_from_hash_round_trip
    details = { "a" => 1 }
    e = BE.dependency(
      code: "CODE", message: "msg", description: "desc", remediation: "rem",
      doc_url: "https://example.com", retryable: true, retry_after_ms: 1234,
      details: details, node: "n", sdk: "blok-ruby", sdk_version: "1.0.0",
      runtime_kind: "runtime.ruby"
    )
    map = e.to_hash
    assert_equal "DEPENDENCY", map["category"]
    assert_equal "CODE", map["code"]
    assert_equal 502, map["http_status"]
    assert_equal 1234, map["retry_after_ms"]

    restored = BE.from_hash(map)
    assert_equal C::DEPENDENCY, restored.category
    assert_equal "CODE", restored.code
    assert_equal "msg", restored.message
    assert_equal "desc", restored.description
    assert_equal 1234, restored.retry_after_ms
    assert_equal "https://example.com", restored.doc_url
  end

  def test_from_hash_accepts_camel_case_keys
    raw = {
      "category"     => "RATE_LIMIT",
      "severity"     => "ERROR",
      "code"         => "RL",
      "message"      => "too many",
      "httpStatus"   => 429,
      "retryable"    => true,
      "retryAfterMs" => 60_000,
      "at"           => "2026-04-29T00:00:00Z",
      "sdkVersion"   => "1.0.0",
      "runtimeKind"  => "runtime.ruby",
      "docUrl"       => "https://docs/example"
    }
    e = BE.from_hash(raw)
    assert_equal C::RATE_LIMIT, e.category
    assert_equal 429, e.http_status
    assert_equal 60_000, e.retry_after_ms
    assert_equal "1.0.0", e.sdk_version
    assert_equal "runtime.ruby", e.runtime_kind
    assert_equal "https://docs/example", e.doc_url
  end

  def test_from_hash_accepts_causes_list
    raw = {
      "category" => "DEPENDENCY",
      "severity" => "ERROR",
      "code"     => "X",
      "message"  => "y",
      "causes"   => [
        { "message" => "inner", "category" => "INTERNAL" }
      ]
    }
    e = BE.from_hash(raw)
    assert_equal 1, e.causes.length
    assert_equal "inner", e.causes[0]["message"]
  end

  # ===== Display / Exception semantics =====================================

  def test_to_string_formats_category_and_message
    e = BE.dependency(code: "X", message: "nope")
    assert_equal "[DEPENDENCY] nope", e.to_s
  end

  def test_can_be_raised_as_standard_error
    e = BE.timeout(code: "X", message: "y")
    assert_raises(BE) { raise e }
  end

  # ===== uncaught code derivation ==========================================

  def test_uncaught_code_strips_namespace_and_uppercases
    assert_equal "UNCAUGHT_IOERROR", BE._uncaught_code(IOError)
    assert_equal "UNCAUGHT_BLOKERROR", BE._uncaught_code(BE)
    assert_equal "UNCAUGHT_ERROR", BE._uncaught_code(nil)
  end

  # ===== cause-chain flattening ============================================

  def test_flatten_causes_walks_cause_chain
    inner = nil
    wrap = nil
    begin
      begin
        raise IOError, "inner"
      rescue IOError
        raise StandardError, "wrapped"
      end
    rescue StandardError => e
      wrap = e
    end
    causes = BE.flatten_causes(wrap)
    assert_equal 2, causes.length
    assert_equal "wrapped", causes[0]["message"]
    assert_equal "inner",   causes[1]["message"]
  end

  def test_flatten_causes_lifts_blok_error_link
    inner = BE.not_found(code: "INNER", message: "inner-msg")
    causes = BE.flatten_causes(inner)
    assert_equal "INNER",     causes[0]["code"]
    assert_equal "NOT_FOUND", causes[0]["category"]
  end

  # ===== BuildContextSnapshot ==============================================

  def test_snapshot_preserves_small_payload
    inputs = { "a" => 1 }
    vars = { "k1" => "v1" }
    snap = Blok::Errors::BuildContextSnapshot.of(inputs: inputs, vars: vars)
    assert_equal 1,    snap["inputs"]["a"]
    assert_equal "v1", snap["vars"]["k1"]
  end

  def test_snapshot_caps_at_max_bytes
    inputs = {}
    vars = {}
    filler = "x" * 100
    80.times { |i| vars[format("k%03d", i)] = filler }
    snap = Blok::Errors::BuildContextSnapshot.of(inputs: inputs, vars: vars)
    bytes = JSON.generate(snap).bytesize
    assert bytes <= BE::CONTEXT_SNAPSHOT_MAX_BYTES + 64,
           "snapshot #{bytes} bytes exceeded budget #{BE::CONTEXT_SNAPSHOT_MAX_BYTES}"
  end

  def test_snapshot_keeps_last_n_keys
    inputs = {}
    vars = {}
    32.times { |i| vars[format("k%02d", i)] = i }
    snap = Blok::Errors::BuildContextSnapshot.with_opts(
      inputs: inputs, vars: vars, max_bytes: 0, max_vars_keys: 5
    )
    kept = snap["vars"]
    assert_equal 5, kept.length
    assert kept.key?("k31")
    refute kept.key?("k00")
  end

  def test_snapshot_disables_var_keys_when_zero
    inputs = {}
    vars = { "only" => 1 }
    snap = Blok::Errors::BuildContextSnapshot.with_opts(
      inputs: inputs, vars: vars, max_bytes: 0, max_vars_keys: 0
    )
    assert_empty snap["vars"]
  end

  # ===== Origin ============================================================

  def test_origin_defaults_uses_sdk_constants
    o = BE::Origin.defaults(node: "n", sdk_version: "1.2.3")
    assert_equal BE::DEFAULT_SDK_NAME,     o.sdk
    assert_equal BE::DEFAULT_RUNTIME_KIND, o.runtime_kind
    assert_equal "n",     o.node
    assert_equal "1.2.3", o.sdk_version
  end

  def test_apply_origin_if_missing_preserves_explicit_fields
    e = BE.internal(code: "X", message: "y", node: "explicit")
    e.apply_origin_if_missing(BE::Origin.defaults(node: "auto", sdk_version: "1.0.0"))
    assert_equal "explicit",                e.node
    assert_equal BE::DEFAULT_SDK_NAME,      e.sdk
    assert_equal BE::DEFAULT_RUNTIME_KIND,  e.runtime_kind
  end
end
