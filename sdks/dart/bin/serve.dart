import 'dart:async';
import 'dart:io';

import 'package:grpc/grpc.dart' as grpc;
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;

import 'package:blok_dart/blok.dart';
import 'package:blok_dart/src/server/grpc_server.dart';
import 'package:blok_dart/src/generated_user_nodes.dart';

Future<void> main() async {
  final env = Platform.environment;
  final host = env['HOST'] ?? '0.0.0.0';
  final grpcPort = int.tryParse(env['GRPC_PORT'] ?? '') ?? 10008;
  final httpPort = int.tryParse(env['PORT'] ?? '') ?? 9008;
  final version = env['VERSION'] ?? '1.0.0';
  final maxMessageBytes =
      int.tryParse(env['BLOK_GRPC_MAX_MESSAGE_BYTES'] ?? '') ??
          16 * 1024 * 1024;
  final registry = NodeRegistry(sdkVersion: version);
  registerBuiltIns(registry);
  registerGeneratedNodes(registry);
  final service = DartRuntimeService(registry,
      sdkVersion: version, maxMessageBytes: maxMessageBytes);
  final grpcServer = grpc.Server.create(
    services: [service],
    keepAliveOptions: const grpc.ServerKeepAliveOptions(
      minIntervalBetweenPingsWithoutData: Duration(seconds: 10),
      maxBadPings: 2,
    ),
  );

  final transport = env['BLOK_TRANSPORT'] ?? 'grpc';
  if (transport == 'grpc' || transport == 'both')
    await grpcServer.serve(address: host, port: grpcPort);
  HttpServer? healthServer;
  if (env['BLOK_DISABLE_READINESS_HTTP'] != 'true') {
    final handler = const Pipeline().addMiddleware(logRequests()).addHandler(
        (request) => request.url.path == 'health'
            ? Response.ok('{"status":"healthy"}',
                headers: {'content-type': 'application/json'})
            : Response.notFound('not found'));
    healthServer = await shelf_io.serve(handler, host, httpPort);
  }
  stdout.writeln(
      'Blok Dart SDK ready (grpc=$grpcPort http=$httpPort nodes=${registry.nodeNames.length})');

  final shutdown = Completer<void>();
  void requestShutdown(ProcessSignal _) {
    if (!shutdown.isCompleted) shutdown.complete();
  }

  ProcessSignal.sigint.watch().listen(requestShutdown);
  ProcessSignal.sigterm.watch().listen(requestShutdown);
  await shutdown.future;
  await grpcServer.shutdown();
  await healthServer?.close(force: false);
}

void registerBuiltIns(NodeRegistry registry) {
  registry.register(defineNode<Map<String, Object?>, Map<String, Object?>>(
    name: 'typed-greet',
    description: 'Greets a person with a typed response.',
    inputSchema: const {
      'type': 'object',
      'required': ['name', 'repeat'],
      'properties': {
        'name': {'type': 'string'},
        'repeat': {'type': 'integer', 'minimum': 1},
      }
    },
    outputSchema: const {
      'type': 'object',
      'required': ['greeting', 'length'],
      'properties': {
        'greeting': {'type': 'string'},
        'length': {'type': 'integer'},
      }
    },
    capabilityManifest: const CapabilityManifest(
      effects: [],
      requiredCapabilities: [],
      determinism: 'deterministic',
      idempotency: 'idempotent',
      maturity: 'stable',
      resourceBounds: {
        'maxDurationMs': 5000,
        'maxInputBytes': 4194304,
        'maxOutputBytes': 4194304,
        'maxConcurrency': 64,
      },
    ),
    decodeInput: (value) => (value as Map).cast<String, Object?>(),
    execute: (context, input) async {
      final repeat = (input['repeat'] as num?)?.toInt() ?? 1;
      final greeting = List.filled(repeat, 'Hello, ${input['name']}').join();
      return {'greeting': greeting, 'length': greeting.length};
    },
  ));
  registry.register(defineNode<Map<String, Object?>, Map<String, Object?>>(
    name: 'chain-test',
    description: 'Returns the incoming context chain value.',
    inputSchema: const {'type': 'object'},
    outputSchema: const {'type': 'object'},
    execute: (context, input) async {
      final rawChain = input['chain'] ?? context.previousOutput;
      final chain = rawChain is List
          ? rawChain
              .map((entry) => (entry as Map).cast<String, Object?>())
              .toList()
          : <Map<String, Object?>>[];
      chain.add({
        'language': 'dart',
        'order': chain.length + 1,
      });
      return {'chain': chain, 'origin': input['origin'] ?? 'unknown'};
    },
  ));
}
