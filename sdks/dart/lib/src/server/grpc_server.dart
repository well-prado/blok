import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:grpc/grpc.dart' as grpc;

import '../generated/blok/runtime/v1/runtime.pb.dart' as pb;
import '../generated/blok/runtime/v1/runtime.pbgrpc.dart';
import '../generated/google/protobuf/timestamp.pb.dart';
import '../errors.dart';
import '../registry.dart';
import '../types.dart';

class DartRuntimeService extends NodeRuntimeServiceBase {
  DartRuntimeService(this.registry,
      {required this.sdkVersion, required this.maxMessageBytes});

  final NodeRegistry registry;
  final String sdkVersion;
  final int maxMessageBytes;

  @override
  Future<pb.ExecuteResponse> execute(
      grpc.ServiceCall call, pb.ExecuteRequest request) async {
    final prepared = _prepare(call, request);
    final result = await _runWithCancellation(call, prepared);
    return _encode(result, prepared.context, prepared.nodeName,
        requestBytes: request.writeToBuffer().length);
  }

  @override
  Stream<pb.ExecuteEvent> executeStream(
      grpc.ServiceCall call, pb.ExecuteRequest request) async* {
    final prepared = _prepare(call, request);
    yield pb.ExecuteEvent(
        started: pb.NodeStarted(at: _timestamp(DateTime.now().toUtc())));
    final result = await _runWithCancellation(call, prepared);
    for (final log in prepared.context.logs) {
      yield pb.ExecuteEvent(
          log: pb.LogLine(
              level: log.level,
              message: log.message,
              attributes: log.attributes,
              timestamp: _timestamp(DateTime.now().toUtc())));
    }
    for (final partial in prepared.context.partialResults) {
      yield pb.ExecuteEvent(
          partial:
              pb.PartialResult(snapshotJson: utf8.encode(jsonEncode(partial))));
    }
    yield pb.ExecuteEvent(
        final_5: _encode(result, prepared.context, prepared.nodeName,
            requestBytes: request.writeToBuffer().length));
  }

  @override
  Future<pb.HealthResponse> health(
          grpc.ServiceCall call, pb.HealthRequest request) async =>
      pb.HealthResponse(
        status: pb.HealthResponse_Status.SERVING,
        sdkVersion: sdkVersion,
        registeredNodes: registry.nodeNames,
      );

  @override
  Future<pb.ListNodesResponse> listNodes(
      grpc.ServiceCall call, pb.ListNodesRequest request) async {
    final response = pb.ListNodesResponse(
        sdkName: 'blok-dart', sdkVersion: sdkVersion, protoVersion: '1.0.0');
    response.nodes
        .addAll(registry.descriptors().map((descriptor) => pb.NodeDescriptor(
              name: descriptor.name,
              description: descriptor.description,
              inputSchemaJson: utf8.encode(jsonEncode(descriptor.inputSchema)),
              outputSchemaJson:
                  utf8.encode(jsonEncode(descriptor.outputSchema)),
              tags: descriptor.tags,
              capabilityManifestJson: descriptor.capabilityManifest == null
                  ? null
                  : utf8.encode(jsonEncode(descriptor.capabilityManifest)),
            )));
    if (_blobDirectory != null) response.capabilities.add('blob-v1');
    return response;
  }

  _PreparedRequest _prepare(grpc.ServiceCall call, pb.ExecuteRequest request) {
    if (!request.hasNode() || request.node.name.isEmpty)
      throw grpc.GrpcError.invalidArgument(
          'ExecuteRequest.node.name is required');
    if (request.inputs.length > maxMessageBytes)
      throw grpc.GrpcError.resourceExhausted(
          'inputs exceed BLOK_GRPC_MAX_MESSAGE_BYTES');
    final state = request.hasState() ? request.state : pb.RuntimeState();
    final trigger = request.hasTrigger() ? request.trigger : pb.TriggerInfo();
    final workflow =
        request.hasWorkflow() ? request.workflow : pb.WorkflowInfo();
    final options =
        request.hasOptions() ? request.options : pb.ExecuteOptions();
    Object? inputs = _decodeJson(request.inputs, 'inputs');
    final blobDir = _blobDirectory;
    if (blobDir != null)
      inputs = ClaimCheck(directory: blobDir, maxBytes: maxMessageBytes)
          .resolve(inputs);
    final body = _decodeJson(trigger.body, 'trigger.body');
    final previous = _decodeJson(state.previousOutput, 'state.previous_output');
    final vars = _decodeObject(state.vars, 'state.vars');
    final deadlineFromOptions = options.deadlineMs > 0
        ? DateTime.now()
            .toUtc()
            .add(Duration(milliseconds: options.deadlineMs.toInt()))
        : null;
    final deadline = _earliest(call.deadline, deadlineFromOptions);
    final context = ExecutionContext(
      runId: workflow.runId,
      workflowName: workflow.name,
      request: RequestContext(
          body: body,
          headers: trigger.headers,
          params: trigger.params,
          query: trigger.query,
          cookies: trigger.cookies,
          method: trigger.method,
          url: trigger.url,
          baseUrl: trigger.baseUrl),
      previousOutput: previous,
      vars: vars,
      env: state.env,
      deadline: deadline,
      stepName: request.hasStep() ? request.step.name : '',
    );
    return _PreparedRequest(
        nodeName: request.node.name, inputs: inputs, context: context);
  }

  Future<ExecutionResult> _runWithCancellation(
      grpc.ServiceCall call, _PreparedRequest prepared) async {
    final timer = Timer.periodic(const Duration(milliseconds: 25), (_) {
      if (call.isCanceled || call.isTimedOut) prepared.context.cancel();
    });
    try {
      final future = registry.execute(
          nodeName: prepared.nodeName,
          inputs: prepared.inputs,
          context: prepared.context);
      final deadline = prepared.context.deadline;
      if (deadline == null) return await future;
      final remaining = deadline.difference(DateTime.now().toUtc());
      if (remaining.isNegative) prepared.context.cancel();
      return await future.timeout(
          remaining.isNegative ? Duration.zero : remaining,
          onTimeout: () =>
              ExecutionResult.failure(const BlokDeadlineException().asError()));
    } finally {
      timer.cancel();
    }
  }

  pb.ExecuteResponse _encode(
      ExecutionResult result, ExecutionContext context, String nodeName,
      {required int requestBytes}) {
    final response = pb.ExecuteResponse(
        success: result.success, contentType: 'application/json');
    final dataBytes = result.success && result.data != null
        ? utf8.encode(jsonEncode(result.data))
        : <int>[];
    if (dataBytes.length > maxMessageBytes)
      return _encode(ExecutionResult.failure(BlokErrorTooLarge(nodeName)),
          context, nodeName,
          requestBytes: requestBytes);
    response.data = dataBytes;
    if (context.vars.isNotEmpty)
      response.varsDelta = utf8.encode(jsonEncode(context.vars));
    response.logs.addAll(context.logs.map((log) => pb.LogLine(
        level: log.level,
        message: log.message,
        attributes: log.attributes,
        timestamp: _timestamp(DateTime.now().toUtc()))));
    response.metrics = pb.Metrics(
        durationMs: 0,
        requestBytes: Int64(requestBytes),
        responseBytes: Int64(dataBytes.length));
    if (!result.success)
      response.error = _error(result.error ?? BlokErrorTooLarge(nodeName));
    return response;
  }

  pb.NodeError _error(BlokError error) => pb.NodeError(
        code: error.code,
        category: _category(error.category),
        severity: pb.ErrorSeverity.ERROR,
        node: error.node.isEmpty ? '' : error.node,
        sdk: error.sdk,
        sdkVersion: sdkVersion,
        runtimeKind: 'runtime.dart',
        at: _timestamp(error.at),
        message: error.message,
        description: error.description,
        remediation: error.remediation,
        docUrl: error.docUrl,
        httpStatus: error.httpStatus,
        retryable: error.retryable,
        retryAfterMs: Int64(error.retryAfterMs),
        detailsJson: error.details == null
            ? null
            : utf8.encode(jsonEncode(error.details)),
      );

  pb.ErrorCategory _category(BlokErrorCategory category) => switch (category) {
        BlokErrorCategory.validation => pb.ErrorCategory.VALIDATION,
        BlokErrorCategory.configuration => pb.ErrorCategory.CONFIGURATION,
        BlokErrorCategory.dependency => pb.ErrorCategory.DEPENDENCY,
        BlokErrorCategory.timeout => pb.ErrorCategory.TIMEOUT,
        BlokErrorCategory.permission => pb.ErrorCategory.PERMISSION,
        BlokErrorCategory.rateLimit => pb.ErrorCategory.RATE_LIMIT,
        BlokErrorCategory.notFound => pb.ErrorCategory.NOT_FOUND,
        BlokErrorCategory.conflict => pb.ErrorCategory.CONFLICT,
        BlokErrorCategory.cancelled => pb.ErrorCategory.CANCELLED,
        BlokErrorCategory.internal => pb.ErrorCategory.INTERNAL,
        BlokErrorCategory.protocol => pb.ErrorCategory.PROTOCOL,
        BlokErrorCategory.data => pb.ErrorCategory.DATA,
      };

  String? get _blobDirectory {
    final value = Platform.environment['BLOK_BLOB_DIR'];
    if (value == null || value.isEmpty) return null;
    return Directory(value).existsSync() ? value : null;
  }
}

class _PreparedRequest {
  const _PreparedRequest(
      {required this.nodeName, required this.inputs, required this.context});
  final String nodeName;
  final Object? inputs;
  final ExecutionContext context;
}

Object? _decodeJson(List<int> bytes, String field) {
  if (bytes.isEmpty) return <String, Object?>{};
  try {
    return jsonDecode(utf8.decode(bytes));
  } on FormatException catch (error) {
    throw grpc.GrpcError.invalidArgument('Invalid JSON in $field: $error');
  }
}

JsonObject _decodeObject(List<int> bytes, String field) {
  final value = _decodeJson(bytes, field);
  if (value is Map<String, Object?>) return value;
  if (value is Map) return value.cast<String, Object?>();
  throw grpc.GrpcError.invalidArgument('$field must be a JSON object');
}

DateTime? _earliest(DateTime? first, DateTime? second) {
  if (first == null) return second;
  if (second == null) return first;
  return first.isBefore(second) ? first : second;
}

Timestamp _timestamp(DateTime value) => Timestamp(
    seconds: Int64(value.millisecondsSinceEpoch ~/ 1000),
    nanos: (value.microsecond % Duration.microsecondsPerSecond) * 1000);

class BlokErrorTooLarge extends BlokError {
  BlokErrorTooLarge(String node)
      : super(
            code: 'OUTPUT_TOO_LARGE',
            message: 'Node output exceeds BLOK_GRPC_MAX_MESSAGE_BYTES',
            category: BlokErrorCategory.data,
            httpStatus: 413,
            node: node);
}

extension on BlokDeadlineException {
  BlokError asError() => BlokError(
      code: 'NODE_DEADLINE_EXCEEDED',
      message: toString(),
      category: BlokErrorCategory.timeout,
      httpStatus: 504,
      retryable: true);
}
