import 'dart:io';

import 'package:blok_dart/blok.dart';
import 'package:test/test.dart';

void main() {
  test('typed nodes validate, execute, and reflect schemas/manifests',
      () async {
    final registry = NodeRegistry();
    registry.register(defineNode<Map<String, Object?>, Map<String, Object?>>(
      name: 'greet',
      description: 'Greets a name.',
      inputSchema: const {
        'type': 'object',
        'required': ['name'],
        'properties': {
          'name': {'type': 'string'}
        }
      },
      outputSchema: const {
        'type': 'object',
        'required': ['message'],
        'properties': {
          'message': {'type': 'string'}
        }
      },
      capabilityManifest:
          const CapabilityManifest(effects: ['read'], requiredCapabilities: []),
      decodeInput: (value) => (value as Map).cast<String, Object?>(),
      execute: (_, input) async => {'message': 'Hello ${input['name']}!'},
    ));
    final context = ExecutionContext(
        runId: 'run',
        workflowName: 'test',
        request: const RequestContext(),
        previousOutput: null,
        vars: {},
        env: {},
        deadline: null);
    final result = await registry.execute(
        nodeName: 'greet', inputs: {'name': 'Ada'}, context: context);
    expect(result.success, isTrue, reason: result.error.toString());
    expect(result.data, {'message': 'Hello Ada!'});
    expect(registry.descriptors().single.capabilityManifest?['classification'],
        'agent-compatible');
  });

  test('invalid typed input produces a structured validation error', () async {
    final registry = NodeRegistry();
    registry.register(defineNode<Map<String, Object?>, Map<String, Object?>>(
      name: 'strict',
      description: 'Strict node.',
      inputSchema: const {
        'type': 'object',
        'required': ['name'],
        'properties': {
          'name': {'type': 'string'}
        }
      },
      outputSchema: const {'type': 'object'},
      decodeInput: (value) => (value as Map).cast<String, Object?>(),
      execute: (_, input) async => input,
    ));
    final context = ExecutionContext(
        runId: 'run',
        workflowName: 'test',
        request: const RequestContext(),
        previousOutput: null,
        vars: {},
        env: {},
        deadline: null);
    final result = await registry.execute(
        nodeName: 'strict', inputs: {'name': 42}, context: context);
    expect(result.success, isFalse);
    expect(result.error?.category, BlokErrorCategory.validation);
  });

  test('claim-check refuses traversal and bounds reads', () {
    final directory = Directory.systemTemp.createTempSync('blok-dart-blob-');
    addTearDown(() => directory.deleteSync(recursive: true));
    expect(
        () => ClaimCheck(directory: directory.path).resolve({
              '\$blokBlob': {'id': '../escape.json'}
            }),
        throwsA(isA<BlokError>()));
    File('${directory.path}/run/payload.json')
      ..parent.createSync(recursive: true)
      ..writeAsStringSync('{"ok":true}');
    expect(
        ClaimCheck(directory: directory.path).resolve({
          '\$blokBlob': {'id': 'run/payload.json'}
        }),
        {'ok': true});
  });
}
