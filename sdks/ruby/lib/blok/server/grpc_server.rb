# frozen_string_literal: true

require "grpc"
require "json"
require "google/protobuf/well_known_types"

require_relative "../runtime/v1/runtime_services_pb"

module Blok
  module Server
    # gRPC implementation of the canonical Blok +NodeRuntime+ v1 service.
    #
    # Wire contract: +proto/blok/runtime/v1/runtime.proto+. Generated stubs
    # live in +lib/blok/runtime/v1/+ (committed; produced by
    # +grpc_tools_ruby_protoc+).
    #
    # Architecture:
    # - +BlokNodeRuntimeService+ is the +GRPC::GenericService+ implementation.
    #   It owns a reference to a shared +Blok::Node::NodeRegistry+ so a
    #   single registry serves both HTTP and gRPC.
    # - +GrpcServer.start+ builds the gRPC server, binds the port, and
    #   returns the started server so callers stop it cleanly.
    # - The codec helpers (+_decode_*+ / +_encode_*+) sit at the boundary
    #   between proto and the SDK's internal types so +NodeRegistry#execute+
    #   runs unchanged regardless of which transport delivered the request.
    #
    # The proto sends +inputs+, +previous_output+, +vars+, and the request
    # +body+ as raw JSON-encoded +bytes+. The SDK JSON-decodes them lazily.
    class BlokNodeRuntimeService < ::Blok::Runtime::V1::NodeRuntime::Service
      def initialize(registry, sdk_version: "1.0.0")
        super()
        @registry = registry
        @sdk_version = sdk_version
      end

      # Unary +Execute+: decode envelope -> dispatch to registry -> encode response.
      def execute(request, _call)
        execution_request = decode_execute_request(request)
        result = @registry.execute(execution_request)
        encode_execute_response(result, execution_request.node.name)
      rescue DecodeError => e
        raise GRPC::InvalidArgument, e.message
      end

      # Server-streaming variant of +execute+. Emits, in order:
      #   1. one +NodeStarted+ event marking call acceptance
      #   2. one terminal +ExecuteResponse+ matching the unary payload
      #
      # Log capture (LogLine events) is intentionally out of scope for the
      # Phase 5 Ruby pilot — +Blok::NodeHandler#execute+ has no per-call
      # logger sink, and threading one through would change the SDK API.
      # Real-time log streaming arrives in a follow-up.
      def execute_stream(request, _call)
        execution_request = decode_execute_request(request)
        node_name = execution_request.node.name

        Enumerator.new do |yielder|
          yielder << ::Blok::Runtime::V1::ExecuteEvent.new(
            started: ::Blok::Runtime::V1::NodeStarted.new(at: now_timestamp)
          )

          result = @registry.execute(execution_request)
          final_response = encode_execute_response(result, node_name)
          yielder << ::Blok::Runtime::V1::ExecuteEvent.new(final: final_response)
        end
      rescue DecodeError => e
        raise GRPC::InvalidArgument, e.message
      end

      # Health check (wire-compatible with grpc.health.v1.Health/Check).
      def health(_request, _call)
        ::Blok::Runtime::V1::HealthResponse.new(
          status: :SERVING,
          sdk_version: @sdk_version,
          registered_nodes: @registry.node_names
        )
      end

      # Discover registered nodes (drives Studio + OpenAPI generation).
      def list_nodes(_request, _call)
        descriptors = @registry.node_names.map do |name|
          ::Blok::Runtime::V1::NodeDescriptor.new(name: name)
        end
        ::Blok::Runtime::V1::ListNodesResponse.new(
          nodes: descriptors,
          sdk_name: "blok-ruby",
          sdk_version: @sdk_version,
          proto_version: "1.0.0"
        )
      end

      private

      # Build a +Google::Protobuf::Timestamp+ for "now". Used by streaming
      # frames to mark call acceptance.
      def now_timestamp
        time = Time.now
        Google::Protobuf::Timestamp.new(seconds: time.to_i, nanos: time.nsec)
      end

      # ===== Codec — proto <-> internal types =====

      class DecodeError < StandardError; end

      def decode_execute_request(req)
        raise DecodeError, "ExecuteRequest.node is required" if req.node.nil? || req.node.name.empty?

        inputs = decode_json_object(req.inputs, "inputs")
        state = req.state || ::Blok::Runtime::V1::RuntimeState.new
        trigger = req.trigger || ::Blok::Runtime::V1::TriggerInfo.new
        workflow = req.workflow || ::Blok::Runtime::V1::WorkflowInfo.new

        previous_output = decode_json_value(state.previous_output, "previous_output")
        vars = decode_json_object(state.vars, "vars")
        body = decode_request_body(trigger.body, trigger.headers.to_h)

        # `trigger["method"]` instead of `trigger.method` — Ruby's
        # `Object#method(name)` shadows the proto field accessor, so we use
        # the bracket syntax which always returns the proto field value.
        request = ::Blok::Types::Request.new(
          body: body,
          headers: trigger.headers.to_h,
          params: trigger.params.to_h,
          query: trigger.query.to_h,
          method: trigger["method"],
          url: trigger.url,
          cookies: trigger.cookies.to_h,
          base_url: trigger.base_url
        )

        response = ::Blok::Types::Response.new(
          data: previous_output,
          content_type: "application/json",
          success: true,
          error: nil
        )

        context = ::Blok::Types::Context.new(
          id: workflow.run_id,
          workflow_name: workflow.name,
          workflow_path: workflow.path,
          request: request,
          response: response,
          vars: vars,
          env: state.env.to_h
        )

        # NodeConfig uses `node_type:` (not `type:`) to avoid Ruby's
        # `Class#type` legacy collision. We also read the proto field via
        # `req.node["type"]` because Ruby's `Object#method` shadows the
        # generated `type` accessor.
        node_config = ::Blok::Types::NodeConfig.new(
          name: req.node.name,
          node_type: req.node["type"],
          config: inputs
        )

        ::Blok::Types::ExecutionRequest.new(node: node_config, context: context)
      end

      def encode_execute_response(result, node_name)
        builder = ::Blok::Runtime::V1::ExecuteResponse.new(
          success: result.success,
          content_type: "application/json"
        )

        if result.success && !result.data.nil?
          builder.data = JSON.generate(result.data)
        end

        if result.vars && !result.vars.empty?
          builder.vars_delta = JSON.generate(result.vars)
        end

        if result.metrics
          builder.metrics = ::Blok::Runtime::V1::Metrics.new(
            duration_ms: (result.metrics.duration_ms || 0.0).to_f,
            cpu_ms: (result.metrics.cpu_ms || 0.0).to_f,
            memory_bytes: (result.metrics.memory_bytes || 0).to_i
          )
        end

        unless result.success
          builder.error = internal_error_to_proto(result.errors, node_name)
        end

        builder
      end

      def internal_error_to_proto(err_val, node_name)
        message = "node error"
        details_json = ""

        case err_val
        when nil
          # keep defaults
        when String
          message = err_val
          details_json = JSON.generate({ "message" => err_val })
        when Hash
          msg = err_val["message"] || err_val[:message]
          message = msg if msg.is_a?(String) && !msg.empty?
          details_json = JSON.generate(err_val)
        else
          message = err_val.to_s
          details_json = JSON.generate({ "message" => message })
        end

        ::Blok::Runtime::V1::NodeError.new(
          code: "RUBY_NODE_ERROR",
          category: :INTERNAL,
          severity: :ERROR,
          node: node_name,
          sdk: "blok-ruby",
          sdk_version: @sdk_version,
          runtime_kind: "runtime.ruby",
          message: message,
          http_status: 500,
          retryable: false,
          details_json: details_json
        )
      end

      def decode_json_object(bytes, field)
        return {} if bytes.nil? || bytes.empty?

        begin
          parsed = JSON.parse(bytes)
        rescue JSON::ParserError => e
          raise DecodeError, "invalid `#{field}` JSON: #{e.message}"
        end

        if parsed.is_a?(Hash)
          parsed
        else
          # Wrap non-object payloads under a reserved key so handlers
          # expecting a hash don't crash.
          { "_value" => parsed }
        end
      end

      def decode_json_value(bytes, field)
        return nil if bytes.nil? || bytes.empty?

        JSON.parse(bytes)
      rescue JSON::ParserError => e
        raise DecodeError, "invalid `#{field}` JSON: #{e.message}"
      end

      def decode_request_body(bytes, headers)
        return nil if bytes.nil? || bytes.empty?

        content_type = pick_header(headers, "content-type")
        if content_type.downcase.include?("application/json")
          begin
            return JSON.parse(bytes)
          rescue JSON::ParserError
            # fall through to raw-string handling
          end
        end

        bytes.dup.force_encoding("UTF-8")
      end

      def pick_header(headers, name)
        return "" if headers.nil?

        match = headers.find { |k, _| k.to_s.downcase == name.downcase }
        match ? match[1].to_s : ""
      end
    end

    # GrpcServer manages the lifecycle of a gRPC server bound to
    # +BlokNodeRuntimeService+. Keeps the lifecycle separate from the codec
    # so callers can run HTTP and gRPC concurrently in the same Ruby process
    # (dual-listen mode).
    class GrpcServer
      # 16 MiB max message size matches the runner-side default and the
      # PHP buffer ceiling from BLOK_FRAMEWORK_FIXES.md #5.
      MAX_MESSAGE_BYTES = 16 * 1024 * 1024

      attr_reader :port, :host

      def initialize(registry, port:, host: "0.0.0.0", sdk_version: "1.0.0")
        @registry = registry
        @port = port
        @host = host
        @sdk_version = sdk_version
        @server = nil
      end

      # Bind and start the gRPC server. The +blocking+ flag controls whether
      # this call returns immediately (false; for dual-listen mode) or blocks
      # until shutdown (true; for grpc-only mode).
      def start(blocking: true)
        raise "gRPC server already started" if @server

        @server = GRPC::RpcServer.new(
          server_args: {
            "grpc.max_send_message_length" => MAX_MESSAGE_BYTES,
            "grpc.max_receive_message_length" => MAX_MESSAGE_BYTES
          }
        )
        @server.add_http2_port("#{@host}:#{@port}", :this_port_is_insecure)
        @server.handle(BlokNodeRuntimeService.new(@registry, sdk_version: @sdk_version))

        warn "Blok gRPC server (NodeRuntime v1) listening on #{@host}:#{@port} " \
             "with #{@registry.node_names.length} nodes registered"

        if blocking
          @server.run_till_terminated
        else
          @thread = Thread.new { @server.run_till_terminated }
          # Give the server a moment to start.
          sleep 0.1
        end
        @server
      end

      def stop
        return unless @server

        @server.stop
        @thread&.join(2)
        @server = nil
        @thread = nil
      end
    end
  end
end
