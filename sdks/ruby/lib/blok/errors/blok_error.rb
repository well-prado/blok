# frozen_string_literal: true

require "json"
require "set"
require "time"

module Blok
  module Errors
    # Structured +BlokError+ per master plan §17 — the canonical error contract
    # every Blok node SDK populates the same way. Mirrors the TypeScript
    # +BlokError+ in +core/shared/src/BlokError.ts+, the Python +BlokError+ in
    # +sdks/python3/blok/errors/blok_error.py+, the Go +BlokError+ in
    # +sdks/go/blok_error.go+, the Rust +BlokError+ in
    # +sdks/rust/src/blok_error.rs+, the Java +BlokError+ in
    # +sdks/java/src/main/java/com/blok/blok/errors/BlokError.java+, and the
    # C# +BlokError+ in +sdks/csharp/src/Blok.Core/Errors/BlokError.cs+, so
    # node authors writing in any language see the same field shape.
    #
    # Idiomatic usage (master plan §17.5 builder pattern, Ruby kwargs flavour):
    #
    #   raise Blok::Errors::BlokError.dependency(
    #     code: "POSTGRES_CONNECT_TIMEOUT",
    #     message: "Could not connect to Postgres within 5s",
    #     description: "Tried host=#{host} port=#{port}; timeout=#{dur}ms",
    #     remediation: "Check DATABASE_URL env var and network reachability",
    #     cause: e,
    #     retryable: true,
    #     retry_after_ms: 5000,
    #     details: { "host" => host, "port" => port }
    #   )
    #
    # Inherits from +StandardError+ so handlers can +raise+ it directly. The
    # legacy +NodeError+ (5 categories) stays available for back-compat. New
    # code should prefer +BlokError+.
    class BlokError < StandardError
      # 12 canonical error categories mirroring proto +blok.runtime.v1.ErrorCategory+.
      module Category
        VALIDATION    = "VALIDATION"
        CONFIGURATION = "CONFIGURATION"
        DEPENDENCY    = "DEPENDENCY"
        TIMEOUT       = "TIMEOUT"
        PERMISSION    = "PERMISSION"
        RATE_LIMIT    = "RATE_LIMIT"
        NOT_FOUND     = "NOT_FOUND"
        CONFLICT      = "CONFLICT"
        CANCELLED     = "CANCELLED"
        INTERNAL      = "INTERNAL"
        PROTOCOL      = "PROTOCOL"
        DATA          = "DATA"

        ALL = [
          VALIDATION, CONFIGURATION, DEPENDENCY, TIMEOUT, PERMISSION, RATE_LIMIT,
          NOT_FOUND, CONFLICT, CANCELLED, INTERNAL, PROTOCOL, DATA
        ].freeze

        # Default HTTP status per category — single source of truth, matches the
        # tables in every other SDK exactly.
        DEFAULT_HTTP_STATUS = {
          VALIDATION    => 400,
          CONFIGURATION => 500,
          DEPENDENCY    => 502,
          TIMEOUT       => 504,
          PERMISSION    => 403,
          RATE_LIMIT    => 429,
          NOT_FOUND     => 404,
          CONFLICT      => 409,
          CANCELLED     => 499,
          INTERNAL      => 500,
          PROTOCOL      => 502,
          DATA          => 422
        }.freeze

        # Default retryable hint per category.
        DEFAULT_RETRYABLE = {
          DEPENDENCY => true,
          TIMEOUT    => true,
          RATE_LIMIT => true
        }.tap { |h| h.default = false }.freeze

        # Parse a wire string into a category, falling back to +INTERNAL+
        # for unknown values (matches Python/Go/Rust/Java/C# behaviour).
        def self.parse(value)
          ALL.include?(value) ? value : INTERNAL
        end
      end

      # 4 severity levels mirroring proto +blok.runtime.v1.ErrorSeverity+.
      module Severity
        INFO  = "INFO"
        WARN  = "WARN"
        ERROR = "ERROR"
        FATAL = "FATAL"

        ALL = [INFO, WARN, ERROR, FATAL].freeze

        # Parse a wire string, falling back to +ERROR+.
        def self.parse(value)
          ALL.include?(value) ? value : ERROR
        end
      end

      DEFAULT_SDK_NAME       = "blok-ruby"
      DEFAULT_RUNTIME_KIND   = "runtime.ruby"
      CONTEXT_SNAPSHOT_MAX_BYTES = 4096

      attr_accessor :category, :severity, :code, :description, :remediation, :doc_url,
                    :http_status, :retryable, :retry_after_ms, :details,
                    :context_snapshot, :causes, :stack, :at,
                    :node, :sdk, :sdk_version, :runtime_kind

      # Raw message stored separately because Ruby's +Exception#message+
      # aliases to +#to_s+, so overriding +to_s+ to format
      # +"[CATEGORY] message"+ would infinite-loop if it re-read
      # +message+. We capture the original here at construction time.
      attr_reader :raw_message

      # Construct a +BlokError+. Prefer the per-category class methods
      # (+BlokError.dependency+, +BlokError.validation+, etc.) — direct
      # construction is supported but the factories pin the category at the
      # call site.
      #
      # @param category [String] One of {Category} constants.
      # @param code [String] Stable machine identifier.
      # @param message [String] One-sentence human summary.
      # @param description [String] Multi-paragraph context.
      # @param remediation [String] Suggested next step.
      # @param doc_url [String] Link to documentation.
      # @param cause [Exception, nil] Underlying cause; flattened into +causes+.
      # @param retryable [Boolean, nil] Override the per-category default.
      # @param retry_after_ms [Integer] Suggested retry-after duration in ms.
      # @param details [Object, nil] Category-specific structured details.
      # @param context_snapshot [Object, nil] Bounded slice of inputs/state.
      # @param http_status [Integer, nil] Override per-category default status.
      # @param severity [String] Defaults to +Severity::ERROR+.
      # @param node [String] Auto-enriched by the gRPC servicer if blank.
      # @param sdk [String] Auto-enriched.
      # @param sdk_version [String] Auto-enriched.
      # @param runtime_kind [String] Auto-enriched.
      # @param at [Time] Defaults to +Time.now.utc+.
      # @param stack [String, nil] Captured stack trace.
      def initialize(
        category,
        code:, message:,
        description: "", remediation: "", doc_url: "",
        cause: nil, retryable: nil, retry_after_ms: 0,
        details: nil, context_snapshot: nil, http_status: nil,
        severity: Severity::ERROR,
        node: "", sdk: "", sdk_version: "", runtime_kind: "",
        at: nil, stack: nil
      )
        super(message)
        @raw_message      = message.to_s
        @category         = Category.parse(category)
        @severity         = Severity.parse(severity)
        @code             = code.to_s
        @description      = description.to_s
        @remediation      = remediation.to_s
        @doc_url          = doc_url.to_s
        @retryable        = retryable.nil? ? Category::DEFAULT_RETRYABLE[@category] : retryable
        @retry_after_ms   = retry_after_ms.to_i
        @details          = details
        @context_snapshot = context_snapshot
        @http_status      = http_status.nil? ? Category::DEFAULT_HTTP_STATUS[@category] : http_status.to_i
        @node             = node.to_s
        @sdk              = sdk.to_s
        @sdk_version      = sdk_version.to_s
        @runtime_kind     = runtime_kind.to_s
        @at               = at || Time.now.utc
        @stack            = stack || self.class._capture_stack
        @causes           = cause.nil? ? [] : self.class.flatten_causes(cause)
      end

      # Display format: +[CATEGORY] message+
      def to_s
        "[#{@category}] #{@raw_message}"
      end

      # Override +Exception#message+ so it returns the raw message (without
      # the +"[CATEGORY] "+ prefix). +Kernel#raise+ uses +#message+ for
      # display when no overriding +to_s+ is provided, but our +to_s+ does
      # the formatting; +#message+ should remain the unformatted string.
      def message
        @raw_message
      end

      # ====== Per-category factory shortcuts =================================

      class << self
        # Builder for a +VALIDATION+ error (default 400, non-retryable).
        def validation(**opts)    = new(Category::VALIDATION, **opts)
        # Builder for a +CONFIGURATION+ error (default 500, non-retryable).
        def configuration(**opts) = new(Category::CONFIGURATION, **opts)
        # Builder for a +DEPENDENCY+ error (default 502, retryable).
        def dependency(**opts)    = new(Category::DEPENDENCY, **opts)
        # Builder for a +TIMEOUT+ error (default 504, retryable).
        def timeout(**opts)       = new(Category::TIMEOUT, **opts)
        # Builder for a +PERMISSION+ error (default 403, non-retryable).
        def permission(**opts)    = new(Category::PERMISSION, **opts)
        # Builder for a +RATE_LIMIT+ error (default 429, retryable).
        def rate_limit(**opts)    = new(Category::RATE_LIMIT, **opts)
        # Builder for a +NOT_FOUND+ error (default 404, non-retryable).
        def not_found(**opts)     = new(Category::NOT_FOUND, **opts)
        # Builder for a +CONFLICT+ error (default 409, non-retryable).
        def conflict(**opts)      = new(Category::CONFLICT, **opts)
        # Builder for a +CANCELLED+ error (default 499, non-retryable).
        def cancelled(**opts)     = new(Category::CANCELLED, **opts)
        # Builder for an +INTERNAL+ error (default 500, non-retryable).
        def internal(**opts)      = new(Category::INTERNAL, **opts)
        # Builder for a +PROTOCOL+ error (default 502, non-retryable).
        def protocol(**opts)      = new(Category::PROTOCOL, **opts)
        # Builder for a +DATA+ error (default 422, non-retryable).
        def data(**opts)          = new(Category::DATA, **opts)
      end

      # ====== Origin auto-enrichment =========================================

      # Carrier of the auto-enrichment fields the gRPC servicer fills into a
      # handler-thrown +BlokError+ when the handler didn't set them
      # explicitly.
      Origin = Struct.new(:node, :sdk, :sdk_version, :runtime_kind, keyword_init: true) do
        # Build an +Origin+ populated with the SDK constants
        # ({DEFAULT_SDK_NAME}, {DEFAULT_RUNTIME_KIND}) and the caller-provided
        # node name + SDK version.
        def self.defaults(node:, sdk_version:)
          new(
            node: node.to_s,
            sdk: BlokError::DEFAULT_SDK_NAME,
            sdk_version: sdk_version.to_s,
            runtime_kind: BlokError::DEFAULT_RUNTIME_KIND
          )
        end
      end

      # Fill in any missing origin fields. Won't overwrite explicit values.
      # @param origin [Origin]
      # @return [self]
      def apply_origin_if_missing(origin)
        return self if origin.nil?
        @node         = origin.node         if @node.empty?
        @sdk          = origin.sdk          if @sdk.empty?
        @sdk_version  = origin.sdk_version  if @sdk_version.empty?
        @runtime_kind = origin.runtime_kind if @runtime_kind.empty?
        self
      end

      # ====== Conversion ===================================================

      # Wrap any value as a +BlokError+. Used by the runner's auto-wrap layer
      # so legacy +raise StandardError+ still produces a structured error.
      #
      # Categorization heuristic:
      # * +BlokError+ — passthrough; missing origin fields filled in.
      # * +NodeError+ (legacy) — preserves message/details/cause; category=INTERNAL.
      # * +Exception+ — wraps as INTERNAL with +code=UNCAUGHT_<TYPE>+.
      # * +Hash+ — extracts +"message"+ key, full payload preserved in details.
      # * +String+ — becomes the message.
      # * +nil+ — placeholder +"node error"+.
      # * everything else — stringified, payload preserved in details.
      #
      # @param value [Object]
      # @param origin [Origin]
      # @return [BlokError]
      def self.from_unknown(value, origin:)
        case value
        when BlokError
          value.apply_origin_if_missing(origin)
          value
        when ::Blok::Errors::NodeError
          internal_kwargs = {
            code:    "UNCAUGHT_NODEERROR",
            message: value.message || "node error",
            details: value.to_hash,
            cause:   value
          }
          new(Category::INTERNAL, **internal_kwargs).apply_origin_if_missing(origin)
        when Exception
          msg = value.message
          msg = "Uncaught error" if msg.nil? || msg.empty?
          new(
            Category::INTERNAL,
            code:    _uncaught_code(value.class),
            message: msg,
            cause:   value
          ).apply_origin_if_missing(origin)
        when nil
          new(Category::INTERNAL, code: "UNCAUGHT_ERROR", message: "node error").apply_origin_if_missing(origin)
        when String
          new(
            Category::INTERNAL,
            code:    "UNCAUGHT_ERROR",
            message: value,
            details: { "message" => value }
          ).apply_origin_if_missing(origin)
        when Hash
          msg = value["message"] || value[:message]
          message = (msg.is_a?(String) && !msg.empty?) ? msg : "node error"
          new(
            Category::INTERNAL,
            code:    "UNCAUGHT_ERROR",
            message: message,
            details: _stringify_keys(value)
          ).apply_origin_if_missing(origin)
        else
          repr = value.to_s
          new(
            Category::INTERNAL,
            code:    "UNCAUGHT_ERROR",
            message: repr,
            details: { "message" => repr }
          ).apply_origin_if_missing(origin)
        end
      end

      # Lossless serialization to a Hash matching the proto wire shape
      # (snake_case keys). Inverse of {.from_hash}.
      # @return [Hash]
      def to_hash
        {
          "code"             => @code,
          "category"         => @category,
          "severity"         => @severity,
          "node"             => @node,
          "sdk"              => @sdk,
          "sdk_version"      => @sdk_version,
          "runtime_kind"     => @runtime_kind,
          "at"               => @at.utc.iso8601(9),
          "message"          => message.to_s,
          "description"      => @description,
          "remediation"      => @remediation,
          "doc_url"          => @doc_url,
          "causes"           => @causes.map { |c| c.dup },
          "stack"            => @stack,
          "context_snapshot" => @context_snapshot,
          "http_status"      => @http_status,
          "retryable"        => @retryable,
          "retry_after_ms"   => @retry_after_ms,
          "details"          => @details
        }
      end

      # Reconstruct a +BlokError+ from a Hash. Tolerates both snake_case
      # (Ruby/Python/Go convention) and camelCase (TS payload shape) keys
      # for cross-language fixture compatibility.
      # @param raw [Hash]
      # @return [BlokError]
      def self.from_hash(raw)
        category = Category.parse(_pick(raw, "category"))
        severity = Severity.parse(_pick(raw, "severity"))
        kwargs = {
          code:             _pick(raw, "code").to_s,
          message:          _pick(raw, "message").to_s,
          description:      _pick(raw, "description").to_s,
          remediation:      _pick(raw, "remediation").to_s,
          doc_url:          _pick(raw, "doc_url", "docUrl").to_s,
          retryable:        _pick(raw, "retryable"),
          retry_after_ms:   (_pick(raw, "retry_after_ms", "retryAfterMs") || 0).to_i,
          details:          raw["details"] || raw[:details],
          context_snapshot: _pick(raw, "context_snapshot", "contextSnapshot"),
          http_status:      _pick(raw, "http_status", "httpStatus"),
          severity:         severity,
          node:             _pick(raw, "node").to_s,
          sdk:              _pick(raw, "sdk").to_s,
          sdk_version:      _pick(raw, "sdk_version", "sdkVersion").to_s,
          runtime_kind:     _pick(raw, "runtime_kind", "runtimeKind").to_s,
          stack:            _pick(raw, "stack").to_s,
          at:               _parse_at(_pick(raw, "at"))
        }
        err = new(category, **kwargs)
        causes = raw["causes"] || raw[:causes]
        if causes.is_a?(Array)
          err.causes = causes.map { |c| c.is_a?(Hash) ? _stringify_keys(c) : c }
        end
        err
      end

      # ====== Cause-chain flattening =========================================

      # Walk a Throwable's +cause+ chain and produce a flat list of payloads.
      # Mirrors the Python/Go/Rust/Java/C# implementations. Cycle-safe.
      # +BlokError+ links are lifted in directly so cross-wire serialization
      # doesn't double-count nested chains.
      # @param exc [Exception]
      # @return [Array<Hash>]
      def self.flatten_causes(exc)
        causes = []
        visited = Set.new
        current = exc
        depth = 0
        while !current.nil? && depth < 32
          break if visited.include?(current.object_id)
          visited << current.object_id
          depth += 1
          if current.is_a?(BlokError)
            payload = current.to_hash
            payload["causes"] = []
            causes << payload
            current.causes.each { |c| causes << c.dup }
            return causes
          end
          causes << _exception_to_payload(current)
          current = current.cause
        end
        causes
      end

      # ====== Internal helpers ==============================================

      # @api private
      def self._exception_to_payload(exc)
        {
          "code"             => _uncaught_code(exc.class),
          "category"         => Category::INTERNAL,
          "severity"         => Severity::ERROR,
          "node"             => "",
          "sdk"              => "",
          "sdk_version"      => "",
          "runtime_kind"     => "",
          "at"               => Time.now.utc.iso8601(9),
          "message"          => (exc.message.nil? || exc.message.empty? ? "Uncaught error" : exc.message),
          "description"      => "",
          "remediation"      => "",
          "doc_url"          => "",
          "causes"           => [],
          "stack"            => (exc.backtrace || []).join("\n"),
          "context_snapshot" => nil,
          "http_status"      => 500,
          "retryable"        => false,
          "retry_after_ms"   => 0,
          "details"          => nil
        }
      end

      # Derive an +UNCAUGHT_<TYPE>+ code from an exception class. Mirrors the
      # Python +UNCAUGHT_CONNECTIONERROR+ and Java +UNCAUGHT_IOEXCEPTION+
      # conventions: simple (unqualified) class name, alphanumerics only,
      # uppercased. The Ruby version strips the leading namespace via
      # +::+ split.
      # @api private
      def self._uncaught_code(klass)
        return "UNCAUGHT_ERROR" if klass.nil?
        simple = klass.name.to_s.split("::").last.to_s
        upper = simple.gsub(/[^A-Za-z0-9]/, "").upcase
        upper.empty? ? "UNCAUGHT_ERROR" : "UNCAUGHT_#{upper}"
      end

      # @api private
      def self._capture_stack
        # `caller` from inside `initialize` skips the BlokError init frames.
        caller(2).join("\n")
      end

      # @api private
      def self._stringify_keys(h)
        h.each_with_object({}) { |(k, v), out| out[k.to_s] = v }
      end

      # @api private
      def self._pick(raw, *keys)
        keys.each do |k|
          return raw[k] if raw.key?(k)
          sym = k.to_sym
          return raw[sym] if raw.key?(sym)
        end
        nil
      end

      # @api private
      def self._parse_at(value)
        return Time.now.utc unless value.is_a?(String) && !value.empty?
        Time.iso8601(value)
      rescue ArgumentError
        Time.now.utc
      end
    end
  end
end
