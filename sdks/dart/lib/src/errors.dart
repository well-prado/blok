import 'dart:convert';

import 'types.dart';

enum BlokErrorCategory {
  validation,
  configuration,
  dependency,
  timeout,
  permission,
  rateLimit,
  notFound,
  conflict,
  cancelled,
  internal,
  protocol,
  data,
}

class BlokError implements Exception {
  BlokError({
    required this.code,
    required this.message,
    required this.category,
    this.description = '',
    this.remediation = '',
    this.docUrl = '',
    this.retryable = false,
    this.retryAfterMs = 0,
    this.httpStatus = 500,
    this.details,
    this.cause,
    this.node = '',
    this.sdk = 'blok-dart',
    this.sdkVersion = '1.0.0',
    this.runtimeKind = 'runtime.dart',
    DateTime? at,
  }) : at = at ?? DateTime.now().toUtc();

  final String code;
  final String message;
  final BlokErrorCategory category;
  final String description;
  final String remediation;
  final String docUrl;
  final bool retryable;
  final int retryAfterMs;
  final int httpStatus;
  final Object? details;
  final Object? cause;
  String node;
  final String sdk;
  final String sdkVersion;
  final String runtimeKind;
  final DateTime at;

  factory BlokError.fromUnknown(Object error, {String node = ''}) {
    if (error is BlokError)
      return error..node = node.isEmpty ? error.node : node;
    if (error is BlokDeadlineException) {
      return BlokError(
          code: 'NODE_DEADLINE_EXCEEDED',
          message: error.toString(),
          category: BlokErrorCategory.timeout,
          retryable: true,
          httpStatus: 504,
          node: node);
    }
    if (error is BlokCancellationException) {
      return BlokError(
          code: 'NODE_CANCELLED',
          message: error.toString(),
          category: BlokErrorCategory.cancelled,
          httpStatus: 499,
          node: node);
    }
    return BlokError(
        code: 'NODE_EXECUTION_FAILED',
        message: '$error',
        category: BlokErrorCategory.internal,
        node: node,
        cause: error);
  }

  Map<String, Object?> toJson() => {
        'code': code,
        'category': category.name.toUpperCase(),
        'severity': 'ERROR',
        'node': node,
        'sdk': sdk,
        'sdkVersion': sdkVersion,
        'runtimeKind': runtimeKind,
        'at': at.toIso8601String(),
        'message': message,
        'description': description,
        'remediation': remediation,
        'docUrl': docUrl,
        'retryable': retryable,
        'retryAfterMs': retryAfterMs,
        'httpStatus': httpStatus,
        'details': details,
        'cause': cause?.toString(),
      };

  @override
  String toString() => jsonEncode(toJson());
}
