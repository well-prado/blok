//
//  Generated code. Do not modify.
//  source: blok/runtime/v1/runtime.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:core' as $core;

import 'package:protobuf/protobuf.dart' as $pb;

class ErrorCategory extends $pb.ProtobufEnum {
  static const ErrorCategory CATEGORY_UNSPECIFIED =
      ErrorCategory._(0, _omitEnumNames ? '' : 'CATEGORY_UNSPECIFIED');
  static const ErrorCategory VALIDATION =
      ErrorCategory._(1, _omitEnumNames ? '' : 'VALIDATION');
  static const ErrorCategory CONFIGURATION =
      ErrorCategory._(2, _omitEnumNames ? '' : 'CONFIGURATION');
  static const ErrorCategory DEPENDENCY =
      ErrorCategory._(3, _omitEnumNames ? '' : 'DEPENDENCY');
  static const ErrorCategory TIMEOUT =
      ErrorCategory._(4, _omitEnumNames ? '' : 'TIMEOUT');
  static const ErrorCategory PERMISSION =
      ErrorCategory._(5, _omitEnumNames ? '' : 'PERMISSION');
  static const ErrorCategory RATE_LIMIT =
      ErrorCategory._(6, _omitEnumNames ? '' : 'RATE_LIMIT');
  static const ErrorCategory NOT_FOUND =
      ErrorCategory._(7, _omitEnumNames ? '' : 'NOT_FOUND');
  static const ErrorCategory CONFLICT =
      ErrorCategory._(8, _omitEnumNames ? '' : 'CONFLICT');
  static const ErrorCategory CANCELLED =
      ErrorCategory._(9, _omitEnumNames ? '' : 'CANCELLED');
  static const ErrorCategory INTERNAL =
      ErrorCategory._(10, _omitEnumNames ? '' : 'INTERNAL');
  static const ErrorCategory PROTOCOL =
      ErrorCategory._(11, _omitEnumNames ? '' : 'PROTOCOL');
  static const ErrorCategory DATA =
      ErrorCategory._(12, _omitEnumNames ? '' : 'DATA');

  static const $core.List<ErrorCategory> values = <ErrorCategory>[
    CATEGORY_UNSPECIFIED,
    VALIDATION,
    CONFIGURATION,
    DEPENDENCY,
    TIMEOUT,
    PERMISSION,
    RATE_LIMIT,
    NOT_FOUND,
    CONFLICT,
    CANCELLED,
    INTERNAL,
    PROTOCOL,
    DATA,
  ];

  static final $core.Map<$core.int, ErrorCategory> _byValue =
      $pb.ProtobufEnum.initByValue(values);
  static ErrorCategory? valueOf($core.int value) => _byValue[value];

  const ErrorCategory._($core.int v, $core.String n) : super(v, n);
}

class ErrorSeverity extends $pb.ProtobufEnum {
  static const ErrorSeverity SEVERITY_UNSPECIFIED =
      ErrorSeverity._(0, _omitEnumNames ? '' : 'SEVERITY_UNSPECIFIED');
  static const ErrorSeverity INFO =
      ErrorSeverity._(1, _omitEnumNames ? '' : 'INFO');
  static const ErrorSeverity WARN =
      ErrorSeverity._(2, _omitEnumNames ? '' : 'WARN');
  static const ErrorSeverity ERROR =
      ErrorSeverity._(3, _omitEnumNames ? '' : 'ERROR');
  static const ErrorSeverity FATAL =
      ErrorSeverity._(4, _omitEnumNames ? '' : 'FATAL');

  static const $core.List<ErrorSeverity> values = <ErrorSeverity>[
    SEVERITY_UNSPECIFIED,
    INFO,
    WARN,
    ERROR,
    FATAL,
  ];

  static final $core.Map<$core.int, ErrorSeverity> _byValue =
      $pb.ProtobufEnum.initByValue(values);
  static ErrorSeverity? valueOf($core.int value) => _byValue[value];

  const ErrorSeverity._($core.int v, $core.String n) : super(v, n);
}

class HealthResponse_Status extends $pb.ProtobufEnum {
  static const HealthResponse_Status UNKNOWN =
      HealthResponse_Status._(0, _omitEnumNames ? '' : 'UNKNOWN');
  static const HealthResponse_Status SERVING =
      HealthResponse_Status._(1, _omitEnumNames ? '' : 'SERVING');
  static const HealthResponse_Status NOT_SERVING =
      HealthResponse_Status._(2, _omitEnumNames ? '' : 'NOT_SERVING');

  static const $core.List<HealthResponse_Status> values =
      <HealthResponse_Status>[
    UNKNOWN,
    SERVING,
    NOT_SERVING,
  ];

  static final $core.Map<$core.int, HealthResponse_Status> _byValue =
      $pb.ProtobufEnum.initByValue(values);
  static HealthResponse_Status? valueOf($core.int value) => _byValue[value];

  const HealthResponse_Status._($core.int v, $core.String n) : super(v, n);
}

const _omitEnumNames = $core.bool.fromEnvironment('protobuf.omit_enum_names');
