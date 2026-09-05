import 'capability_manifest.dart';
import 'errors.dart';
import 'types.dart';

typedef NodeExecutor<I, O> = Future<O> Function(
    ExecutionContext context, I input);

class NodeDefinition<I, O> {
  NodeDefinition({
    required this.name,
    required this.description,
    required this.inputSchema,
    required this.outputSchema,
    required this.execute,
    this.capabilityManifest,
    this.tags = const [],
    I Function(Object?)? decodeInput,
    Object? Function(O)? encodeOutput,
  })  : decodeInput = decodeInput ?? ((value) => value as I),
        encodeOutput = encodeOutput ?? ((value) => value);

  final String name;
  final String description;
  final Map<String, Object?> inputSchema;
  final Map<String, Object?> outputSchema;
  final NodeExecutor<I, O> execute;
  final CapabilityManifest? capabilityManifest;
  final List<String> tags;
  final I Function(Object?) decodeInput;
  final Object? Function(O) encodeOutput;

  Future<Object?> invoke(ExecutionContext context, Object? value) async {
    final output = await execute(context, decodeInput(value));
    return encodeOutput(output);
  }
}

NodeDefinition<I, O> defineNode<I, O>({
  required String name,
  required String description,
  required Map<String, Object?> inputSchema,
  required Map<String, Object?> outputSchema,
  required NodeExecutor<I, O> execute,
  CapabilityManifest? capabilityManifest,
  List<String> tags = const [],
  I Function(Object?)? decodeInput,
  Object? Function(O)? encodeOutput,
}) =>
    NodeDefinition<I, O>(
      name: name,
      description: description,
      inputSchema: inputSchema,
      outputSchema: outputSchema,
      execute: execute,
      capabilityManifest: capabilityManifest,
      tags: tags,
      decodeInput: decodeInput,
      encodeOutput: encodeOutput,
    );

void validateJsonSchema(Object? value, Map<String, Object?> schema,
    {String path = r'$'}) {
  final type = schema['type'];
  if (type == 'object') {
    if (value is! Map)
      throw BlokError(
          code: 'INPUT_VALIDATION_FAILED',
          message: '$path must be an object',
          category: BlokErrorCategory.validation,
          httpStatus: 400);
    for (final key in (schema['required'] as List<Object?>? ?? const [])) {
      if (!value.containsKey(key))
        throw BlokError(
            code: 'INPUT_VALIDATION_FAILED',
            message: '$path.$key is required',
            category: BlokErrorCategory.validation,
            httpStatus: 400);
    }
    final properties =
        (schema['properties'] as Map<Object?, Object?>? ?? const {});
    for (final entry in properties.entries) {
      if (value.containsKey(entry.key))
        validateJsonSchema(
            value[entry.key], (entry.value as Map).cast<String, Object?>(),
            path: '$path.${entry.key}');
    }
  } else if (type == 'array' && value is! List) {
    throw BlokError(
        code: 'INPUT_VALIDATION_FAILED',
        message: '$path must be an array',
        category: BlokErrorCategory.validation,
        httpStatus: 400);
  } else if (type == 'string' && value is! String) {
    throw BlokError(
        code: 'INPUT_VALIDATION_FAILED',
        message: '$path must be a string',
        category: BlokErrorCategory.validation,
        httpStatus: 400);
  } else if (type == 'integer' && (value is! int || value is bool)) {
    throw BlokError(
        code: 'INPUT_VALIDATION_FAILED',
        message: '$path must be an integer',
        category: BlokErrorCategory.validation,
        httpStatus: 400);
  } else if (type == 'number' && (value is! num || value is bool)) {
    throw BlokError(
        code: 'INPUT_VALIDATION_FAILED',
        message: '$path must be a number',
        category: BlokErrorCategory.validation,
        httpStatus: 400);
  } else if (type == 'boolean' && value is! bool) {
    throw BlokError(
        code: 'INPUT_VALIDATION_FAILED',
        message: '$path must be a boolean',
        category: BlokErrorCategory.validation,
        httpStatus: 400);
  }
  final minimum = schema['minimum'];
  if (minimum is num && value is num && value < minimum) {
    throw BlokError(
        code: 'INPUT_VALIDATION_FAILED',
        message: '$path must be at least $minimum',
        category: BlokErrorCategory.validation,
        httpStatus: 400);
  }
}
