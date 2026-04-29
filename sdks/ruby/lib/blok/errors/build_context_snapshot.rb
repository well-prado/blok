# frozen_string_literal: true

require "json"

module Blok
  module Errors
    # Bounded slice of inputs + recent vars for the
    # +BlokError#context_snapshot+ field, per master plan §17.6.
    #
    # Default budget: 4 KB serialized + last-16 vars keys, with progressive
    # trimming when oversize. +inputs+ is preserved as-is — it's the most
    # LLM-actionable context. Mirrors Python's +build_context_snapshot+, Go's
    # +BuildContextSnapshot+, Rust's +build_context_snapshot+, Java's
    # +BuildContextSnapshot.of+, and C#'s +BuildContextSnapshot.Of+.
    module BuildContextSnapshot
      module_function

      # Snapshot of +inputs+ + last-16 vars keys, capped at 4 KB.
      # @param inputs [Hash, nil]
      # @param vars [Hash, nil]
      # @return [Hash]
      def of(inputs:, vars:)
        with_opts(inputs: inputs, vars: vars,
                  max_bytes: BlokError::CONTEXT_SNAPSHOT_MAX_BYTES, max_vars_keys: 16)
      end

      # Customizable variant of {.of}. +max_vars_keys+ = 0 drops vars
      # entirely. +max_bytes+ <= 0 disables byte-budget trimming.
      # @param inputs [Hash, nil]
      # @param vars [Hash, nil]
      # @param max_bytes [Integer]
      # @param max_vars_keys [Integer]
      # @return [Hash]
      def with_opts(inputs:, vars:, max_bytes:, max_vars_keys:)
        safe_inputs = json_safe(inputs || {})

        # Sort vars keys for a deterministic "last N" slice. Ruby Hash since
        # 1.9 is insertion-ordered, but tests need cross-runtime determinism;
        # mirroring Java's TreeMap, Rust's BTreeMap, and C#'s SortedDictionary.
        sorted_keys = (vars || {}).keys.map(&:to_s).sort
        if max_vars_keys >= 0 && sorted_keys.length > max_vars_keys
          sorted_keys = sorted_keys.last(max_vars_keys)
        end

        recent = build_recent(vars, sorted_keys)
        snapshot = { "inputs" => safe_inputs, "vars" => recent }

        return snapshot if max_bytes <= 0
        return snapshot if encoded_bytes(snapshot) <= max_bytes

        # Trim from the front (oldest keys) until the snapshot fits.
        while !sorted_keys.empty?
          sorted_keys = sorted_keys[1..]
          snapshot["vars"] = build_recent(vars, sorted_keys)
          return snapshot if encoded_bytes(snapshot) <= max_bytes
        end

        { "inputs" => safe_inputs, "vars" => {}, "_truncated" => true }
      end

      # ===== Internal helpers ================================================

      def encoded_bytes(value)
        JSON.generate(value).bytesize
      rescue JSON::JSONError
        Float::INFINITY
      end

      def build_recent(vars, keys)
        return {} if vars.nil?
        keys.each_with_object({}) do |k, out|
          # Hash#fetch supports both string and symbol keys.
          val = vars[k] || vars[k.to_sym]
          out[k] = json_safe(val)
        end
      end

      def json_safe(value)
        case value
        when nil, true, false, Numeric, String
          value
        when Symbol
          value.to_s
        when Hash
          value.each_with_object({}) { |(k, v), out| out[k.to_s] = json_safe(v) }
        when Array
          value.map { |v| json_safe(v) }
        else
          # Try a JSON round-trip; fall back to to_s for un-serializable values.
          begin
            JSON.parse(JSON.generate(value))
          rescue JSON::JSONError
            value.to_s
          end
        end
      end
    end
  end
end
