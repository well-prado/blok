import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'errors.dart';
import 'node.dart';
import 'types.dart';

class NodeRegistry {
  NodeRegistry({this.sdkVersion = '1.0.0'});

  final String sdkVersion;
  final Map<String, NodeDefinition<dynamic, dynamic>> _nodes = {};

  void register<I, O>(NodeDefinition<I, O> node) {
    if (_nodes.containsKey(node.name))
      throw ArgumentError('Duplicate node: ${node.name}');
    _nodes[node.name] = node as NodeDefinition<dynamic, dynamic>;
  }

  NodeDefinition<dynamic, dynamic>? get(String name) => _nodes[name];
  List<String> get nodeNames => _nodes.keys.toList()..sort();

  Future<ExecutionResult> execute({
    required String nodeName,
    required Object? inputs,
    required ExecutionContext context,
  }) async {
    final node = _nodes[nodeName];
    if (node == null)
      return ExecutionResult.failure(BlokError(
          code: 'NODE_NOT_FOUND',
          message: 'Node "$nodeName" is not registered',
          category: BlokErrorCategory.notFound,
          httpStatus: 404,
          node: nodeName));
    try {
      context.checkActive();
      validateJsonSchema(inputs, node.inputSchema);
      final output = await node.invoke(context, inputs);
      context.checkActive();
      validateJsonSchema(output, node.outputSchema);
      return ExecutionResult.success(output);
    } catch (error) {
      return ExecutionResult.failure(
          BlokError.fromUnknown(error, node: nodeName));
    }
  }

  int loadUserNodes(String? directory) {
    if (directory == null || directory.isEmpty) return 0;
    final root = Directory(directory);
    if (!root.existsSync()) return 0;
    // Dart cannot safely import arbitrary source paths at runtime. Production
    // scaffolds use generated `bin/register_user_nodes.dart`; this scan is a
    // validation hook that reports the expected layout without eval/dynamic
    // code loading.
    return root
        .listSync(followLinks: false)
        .whereType<Directory>()
        .where((dir) => File('${dir.path}/node.dart').existsSync())
        .length;
  }

  List<NodeDescriptor> descriptors() => nodeNames.map((name) {
        final node = _nodes[name]!;
        return NodeDescriptor(
            name: name,
            description: node.description,
            inputSchema: node.inputSchema,
            outputSchema: node.outputSchema,
            tags: node.tags,
            capabilityManifest: node.capabilityManifest?.toJson());
      }).toList();
}

class ExecutionResult {
  const ExecutionResult._({required this.success, this.data, this.error});
  factory ExecutionResult.success(Object? data) =>
      ExecutionResult._(success: true, data: data);
  factory ExecutionResult.failure(BlokError error) =>
      ExecutionResult._(success: false, error: error);
  final bool success;
  final Object? data;
  final BlokError? error;
}

class NodeDescriptor {
  const NodeDescriptor(
      {required this.name,
      required this.description,
      required this.inputSchema,
      required this.outputSchema,
      required this.tags,
      this.capabilityManifest});
  final String name;
  final String description;
  final Map<String, Object?> inputSchema;
  final Map<String, Object?> outputSchema;
  final List<String> tags;
  final Map<String, Object?>? capabilityManifest;
}

class ClaimCheck {
  ClaimCheck({required this.directory, this.maxBytes = 16 * 1024 * 1024});
  final String directory;
  final int maxBytes;

  Object? resolve(Object? value) {
    if (value is! Map || value.length != 1 || value[r'$blokBlob'] is! Map)
      return value;
    final ref = (value[r'$blokBlob'] as Map).cast<Object?, Object?>();
    final id = ref['id'];
    if (id is! String ||
        !RegExp(r'^[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$')
            .hasMatch(id)) {
      throw BlokError(
          code: 'BLOB_REF_INVALID',
          message: 'Invalid blob id',
          category: BlokErrorCategory.validation,
          httpStatus: 400);
    }
    final file = File('$directory${Platform.pathSeparator}$id');
    final resolvedRoot = Directory(directory).absolute.path;
    if (!file.absolute.path
        .startsWith('$resolvedRoot${Platform.pathSeparator}'))
      throw BlokError(
          code: 'BLOB_REF_INVALID',
          message: 'Blob path escapes BLOK_BLOB_DIR',
          category: BlokErrorCategory.permission,
          httpStatus: 403);
    final length = file.lengthSync();
    if (length > maxBytes)
      throw BlokError(
          code: 'BLOB_TOO_LARGE',
          message: 'Blob exceeds configured read limit',
          category: BlokErrorCategory.data,
          httpStatus: 413);
    final parsed = jsonDecode(file.readAsStringSync());
    return parsed is Map ? parsed : {'_value': parsed};
  }
}
