//
//  Generated code. Do not modify.
//  source: blok/runtime/v1/runtime.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:async' as $async;
import 'dart:core' as $core;

import 'package:grpc/service_api.dart' as $grpc;
import 'package:protobuf/protobuf.dart' as $pb;

import 'runtime.pb.dart' as $0;

export 'runtime.pb.dart';

@$pb.GrpcServiceName('blok.runtime.v1.NodeRuntime')
class NodeRuntimeClient extends $grpc.Client {
  static final _$execute =
      $grpc.ClientMethod<$0.ExecuteRequest, $0.ExecuteResponse>(
          '/blok.runtime.v1.NodeRuntime/Execute',
          ($0.ExecuteRequest value) => value.writeToBuffer(),
          ($core.List<$core.int> value) =>
              $0.ExecuteResponse.fromBuffer(value));
  static final _$executeStream =
      $grpc.ClientMethod<$0.ExecuteRequest, $0.ExecuteEvent>(
          '/blok.runtime.v1.NodeRuntime/ExecuteStream',
          ($0.ExecuteRequest value) => value.writeToBuffer(),
          ($core.List<$core.int> value) => $0.ExecuteEvent.fromBuffer(value));
  static final _$health =
      $grpc.ClientMethod<$0.HealthRequest, $0.HealthResponse>(
          '/blok.runtime.v1.NodeRuntime/Health',
          ($0.HealthRequest value) => value.writeToBuffer(),
          ($core.List<$core.int> value) => $0.HealthResponse.fromBuffer(value));
  static final _$listNodes =
      $grpc.ClientMethod<$0.ListNodesRequest, $0.ListNodesResponse>(
          '/blok.runtime.v1.NodeRuntime/ListNodes',
          ($0.ListNodesRequest value) => value.writeToBuffer(),
          ($core.List<$core.int> value) =>
              $0.ListNodesResponse.fromBuffer(value));

  NodeRuntimeClient($grpc.ClientChannel channel,
      {$grpc.CallOptions? options,
      $core.Iterable<$grpc.ClientInterceptor>? interceptors})
      : super(channel, options: options, interceptors: interceptors);

  $grpc.ResponseFuture<$0.ExecuteResponse> execute($0.ExecuteRequest request,
      {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$execute, request, options: options);
  }

  $grpc.ResponseStream<$0.ExecuteEvent> executeStream($0.ExecuteRequest request,
      {$grpc.CallOptions? options}) {
    return $createStreamingCall(
        _$executeStream, $async.Stream.fromIterable([request]),
        options: options);
  }

  $grpc.ResponseFuture<$0.HealthResponse> health($0.HealthRequest request,
      {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$health, request, options: options);
  }

  $grpc.ResponseFuture<$0.ListNodesResponse> listNodes(
      $0.ListNodesRequest request,
      {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$listNodes, request, options: options);
  }
}

@$pb.GrpcServiceName('blok.runtime.v1.NodeRuntime')
abstract class NodeRuntimeServiceBase extends $grpc.Service {
  $core.String get $name => 'blok.runtime.v1.NodeRuntime';

  NodeRuntimeServiceBase() {
    $addMethod($grpc.ServiceMethod<$0.ExecuteRequest, $0.ExecuteResponse>(
        'Execute',
        execute_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.ExecuteRequest.fromBuffer(value),
        ($0.ExecuteResponse value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.ExecuteRequest, $0.ExecuteEvent>(
        'ExecuteStream',
        executeStream_Pre,
        false,
        true,
        ($core.List<$core.int> value) => $0.ExecuteRequest.fromBuffer(value),
        ($0.ExecuteEvent value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.HealthRequest, $0.HealthResponse>(
        'Health',
        health_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.HealthRequest.fromBuffer(value),
        ($0.HealthResponse value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.ListNodesRequest, $0.ListNodesResponse>(
        'ListNodes',
        listNodes_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.ListNodesRequest.fromBuffer(value),
        ($0.ListNodesResponse value) => value.writeToBuffer()));
  }

  $async.Future<$0.ExecuteResponse> execute_Pre(
      $grpc.ServiceCall call, $async.Future<$0.ExecuteRequest> request) async {
    return execute(call, await request);
  }

  $async.Stream<$0.ExecuteEvent> executeStream_Pre(
      $grpc.ServiceCall call, $async.Future<$0.ExecuteRequest> request) async* {
    yield* executeStream(call, await request);
  }

  $async.Future<$0.HealthResponse> health_Pre(
      $grpc.ServiceCall call, $async.Future<$0.HealthRequest> request) async {
    return health(call, await request);
  }

  $async.Future<$0.ListNodesResponse> listNodes_Pre($grpc.ServiceCall call,
      $async.Future<$0.ListNodesRequest> request) async {
    return listNodes(call, await request);
  }

  $async.Future<$0.ExecuteResponse> execute(
      $grpc.ServiceCall call, $0.ExecuteRequest request);
  $async.Stream<$0.ExecuteEvent> executeStream(
      $grpc.ServiceCall call, $0.ExecuteRequest request);
  $async.Future<$0.HealthResponse> health(
      $grpc.ServiceCall call, $0.HealthRequest request);
  $async.Future<$0.ListNodesResponse> listNodes(
      $grpc.ServiceCall call, $0.ListNodesRequest request);
}
