//
//  Generated code. Do not modify.
//  source: blok/runtime/v1/runtime.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:convert' as $convert;
import 'dart:core' as $core;
import 'dart:typed_data' as $typed_data;

@$core.Deprecated('Use errorCategoryDescriptor instead')
const ErrorCategory$json = {
  '1': 'ErrorCategory',
  '2': [
    {'1': 'CATEGORY_UNSPECIFIED', '2': 0},
    {'1': 'VALIDATION', '2': 1},
    {'1': 'CONFIGURATION', '2': 2},
    {'1': 'DEPENDENCY', '2': 3},
    {'1': 'TIMEOUT', '2': 4},
    {'1': 'PERMISSION', '2': 5},
    {'1': 'RATE_LIMIT', '2': 6},
    {'1': 'NOT_FOUND', '2': 7},
    {'1': 'CONFLICT', '2': 8},
    {'1': 'CANCELLED', '2': 9},
    {'1': 'INTERNAL', '2': 10},
    {'1': 'PROTOCOL', '2': 11},
    {'1': 'DATA', '2': 12},
  ],
};

/// Descriptor for `ErrorCategory`. Decode as a `google.protobuf.EnumDescriptorProto`.
final $typed_data.Uint8List errorCategoryDescriptor = $convert.base64Decode(
    'Cg1FcnJvckNhdGVnb3J5EhgKFENBVEVHT1JZX1VOU1BFQ0lGSUVEEAASDgoKVkFMSURBVElPTh'
    'ABEhEKDUNPTkZJR1VSQVRJT04QAhIOCgpERVBFTkRFTkNZEAMSCwoHVElNRU9VVBAEEg4KClBF'
    'Uk1JU1NJT04QBRIOCgpSQVRFX0xJTUlUEAYSDQoJTk9UX0ZPVU5EEAcSDAoIQ09ORkxJQ1QQCB'
    'INCglDQU5DRUxMRUQQCRIMCghJTlRFUk5BTBAKEgwKCFBST1RPQ09MEAsSCAoEREFUQRAM');

@$core.Deprecated('Use errorSeverityDescriptor instead')
const ErrorSeverity$json = {
  '1': 'ErrorSeverity',
  '2': [
    {'1': 'SEVERITY_UNSPECIFIED', '2': 0},
    {'1': 'INFO', '2': 1},
    {'1': 'WARN', '2': 2},
    {'1': 'ERROR', '2': 3},
    {'1': 'FATAL', '2': 4},
  ],
};

/// Descriptor for `ErrorSeverity`. Decode as a `google.protobuf.EnumDescriptorProto`.
final $typed_data.Uint8List errorSeverityDescriptor = $convert.base64Decode(
    'Cg1FcnJvclNldmVyaXR5EhgKFFNFVkVSSVRZX1VOU1BFQ0lGSUVEEAASCAoESU5GTxABEggKBF'
    'dBUk4QAhIJCgVFUlJPUhADEgkKBUZBVEFMEAQ=');

@$core.Deprecated('Use executeRequestDescriptor instead')
const ExecuteRequest$json = {
  '1': 'ExecuteRequest',
  '2': [
    {
      '1': 'node',
      '3': 1,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.NodeRef',
      '10': 'node'
    },
    {'1': 'inputs', '3': 2, '4': 1, '5': 12, '10': 'inputs'},
    {
      '1': 'step',
      '3': 3,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.StepInfo',
      '10': 'step'
    },
    {
      '1': 'trigger',
      '3': 4,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.TriggerInfo',
      '10': 'trigger'
    },
    {
      '1': 'state',
      '3': 5,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.RuntimeState',
      '10': 'state'
    },
    {
      '1': 'workflow',
      '3': 6,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.WorkflowInfo',
      '10': 'workflow'
    },
    {
      '1': 'options',
      '3': 7,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.ExecuteOptions',
      '10': 'options'
    },
  ],
};

/// Descriptor for `ExecuteRequest`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List executeRequestDescriptor = $convert.base64Decode(
    'Cg5FeGVjdXRlUmVxdWVzdBIsCgRub2RlGAEgASgLMhguYmxvay5ydW50aW1lLnYxLk5vZGVSZW'
    'ZSBG5vZGUSFgoGaW5wdXRzGAIgASgMUgZpbnB1dHMSLQoEc3RlcBgDIAEoCzIZLmJsb2sucnVu'
    'dGltZS52MS5TdGVwSW5mb1IEc3RlcBI2Cgd0cmlnZ2VyGAQgASgLMhwuYmxvay5ydW50aW1lLn'
    'YxLlRyaWdnZXJJbmZvUgd0cmlnZ2VyEjMKBXN0YXRlGAUgASgLMh0uYmxvay5ydW50aW1lLnYx'
    'LlJ1bnRpbWVTdGF0ZVIFc3RhdGUSOQoId29ya2Zsb3cYBiABKAsyHS5ibG9rLnJ1bnRpbWUudj'
    'EuV29ya2Zsb3dJbmZvUgh3b3JrZmxvdxI5CgdvcHRpb25zGAcgASgLMh8uYmxvay5ydW50aW1l'
    'LnYxLkV4ZWN1dGVPcHRpb25zUgdvcHRpb25z');

@$core.Deprecated('Use nodeRefDescriptor instead')
const NodeRef$json = {
  '1': 'NodeRef',
  '2': [
    {'1': 'name', '3': 1, '4': 1, '5': 9, '10': 'name'},
    {'1': 'type', '3': 2, '4': 1, '5': 9, '10': 'type'},
    {'1': 'version', '3': 3, '4': 1, '5': 9, '10': 'version'},
  ],
};

/// Descriptor for `NodeRef`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List nodeRefDescriptor = $convert.base64Decode(
    'CgdOb2RlUmVmEhIKBG5hbWUYASABKAlSBG5hbWUSEgoEdHlwZRgCIAEoCVIEdHlwZRIYCgd2ZX'
    'JzaW9uGAMgASgJUgd2ZXJzaW9u');

@$core.Deprecated('Use stepInfoDescriptor instead')
const StepInfo$json = {
  '1': 'StepInfo',
  '2': [
    {'1': 'name', '3': 1, '4': 1, '5': 9, '10': 'name'},
    {'1': 'index', '3': 2, '4': 1, '5': 5, '10': 'index'},
    {'1': 'total', '3': 3, '4': 1, '5': 5, '10': 'total'},
    {'1': 'depth', '3': 4, '4': 1, '5': 5, '10': 'depth'},
  ],
};

/// Descriptor for `StepInfo`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List stepInfoDescriptor = $convert.base64Decode(
    'CghTdGVwSW5mbxISCgRuYW1lGAEgASgJUgRuYW1lEhQKBWluZGV4GAIgASgFUgVpbmRleBIUCg'
    'V0b3RhbBgDIAEoBVIFdG90YWwSFAoFZGVwdGgYBCABKAVSBWRlcHRo');

@$core.Deprecated('Use triggerInfoDescriptor instead')
const TriggerInfo$json = {
  '1': 'TriggerInfo',
  '2': [
    {'1': 'body', '3': 1, '4': 1, '5': 12, '10': 'body'},
    {
      '1': 'headers',
      '3': 2,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.TriggerInfo.HeadersEntry',
      '10': 'headers'
    },
    {
      '1': 'params',
      '3': 3,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.TriggerInfo.ParamsEntry',
      '10': 'params'
    },
    {
      '1': 'query',
      '3': 4,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.TriggerInfo.QueryEntry',
      '10': 'query'
    },
    {
      '1': 'cookies',
      '3': 5,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.TriggerInfo.CookiesEntry',
      '10': 'cookies'
    },
    {'1': 'method', '3': 6, '4': 1, '5': 9, '10': 'method'},
    {'1': 'url', '3': 7, '4': 1, '5': 9, '10': 'url'},
    {'1': 'base_url', '3': 8, '4': 1, '5': 9, '10': 'baseUrl'},
    {'1': 'trigger_kind', '3': 9, '4': 1, '5': 9, '10': 'triggerKind'},
  ],
  '3': [
    TriggerInfo_HeadersEntry$json,
    TriggerInfo_ParamsEntry$json,
    TriggerInfo_QueryEntry$json,
    TriggerInfo_CookiesEntry$json
  ],
};

@$core.Deprecated('Use triggerInfoDescriptor instead')
const TriggerInfo_HeadersEntry$json = {
  '1': 'HeadersEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

@$core.Deprecated('Use triggerInfoDescriptor instead')
const TriggerInfo_ParamsEntry$json = {
  '1': 'ParamsEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

@$core.Deprecated('Use triggerInfoDescriptor instead')
const TriggerInfo_QueryEntry$json = {
  '1': 'QueryEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

@$core.Deprecated('Use triggerInfoDescriptor instead')
const TriggerInfo_CookiesEntry$json = {
  '1': 'CookiesEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

/// Descriptor for `TriggerInfo`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List triggerInfoDescriptor = $convert.base64Decode(
    'CgtUcmlnZ2VySW5mbxISCgRib2R5GAEgASgMUgRib2R5EkMKB2hlYWRlcnMYAiADKAsyKS5ibG'
    '9rLnJ1bnRpbWUudjEuVHJpZ2dlckluZm8uSGVhZGVyc0VudHJ5UgdoZWFkZXJzEkAKBnBhcmFt'
    'cxgDIAMoCzIoLmJsb2sucnVudGltZS52MS5UcmlnZ2VySW5mby5QYXJhbXNFbnRyeVIGcGFyYW'
    '1zEj0KBXF1ZXJ5GAQgAygLMicuYmxvay5ydW50aW1lLnYxLlRyaWdnZXJJbmZvLlF1ZXJ5RW50'
    'cnlSBXF1ZXJ5EkMKB2Nvb2tpZXMYBSADKAsyKS5ibG9rLnJ1bnRpbWUudjEuVHJpZ2dlckluZm'
    '8uQ29va2llc0VudHJ5Ugdjb29raWVzEhYKBm1ldGhvZBgGIAEoCVIGbWV0aG9kEhAKA3VybBgH'
    'IAEoCVIDdXJsEhkKCGJhc2VfdXJsGAggASgJUgdiYXNlVXJsEiEKDHRyaWdnZXJfa2luZBgJIA'
    'EoCVILdHJpZ2dlcktpbmQaOgoMSGVhZGVyc0VudHJ5EhAKA2tleRgBIAEoCVIDa2V5EhQKBXZh'
    'bHVlGAIgASgJUgV2YWx1ZToCOAEaOQoLUGFyYW1zRW50cnkSEAoDa2V5GAEgASgJUgNrZXkSFA'
    'oFdmFsdWUYAiABKAlSBXZhbHVlOgI4ARo4CgpRdWVyeUVudHJ5EhAKA2tleRgBIAEoCVIDa2V5'
    'EhQKBXZhbHVlGAIgASgJUgV2YWx1ZToCOAEaOgoMQ29va2llc0VudHJ5EhAKA2tleRgBIAEoCV'
    'IDa2V5EhQKBXZhbHVlGAIgASgJUgV2YWx1ZToCOAE=');

@$core.Deprecated('Use runtimeStateDescriptor instead')
const RuntimeState$json = {
  '1': 'RuntimeState',
  '2': [
    {'1': 'previous_output', '3': 1, '4': 1, '5': 12, '10': 'previousOutput'},
    {'1': 'vars', '3': 2, '4': 1, '5': 12, '10': 'vars'},
    {
      '1': 'env',
      '3': 3,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.RuntimeState.EnvEntry',
      '10': 'env'
    },
  ],
  '3': [RuntimeState_EnvEntry$json],
};

@$core.Deprecated('Use runtimeStateDescriptor instead')
const RuntimeState_EnvEntry$json = {
  '1': 'EnvEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

/// Descriptor for `RuntimeState`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List runtimeStateDescriptor = $convert.base64Decode(
    'CgxSdW50aW1lU3RhdGUSJwoPcHJldmlvdXNfb3V0cHV0GAEgASgMUg5wcmV2aW91c091dHB1dB'
    'ISCgR2YXJzGAIgASgMUgR2YXJzEjgKA2VudhgDIAMoCzImLmJsb2sucnVudGltZS52MS5SdW50'
    'aW1lU3RhdGUuRW52RW50cnlSA2Vudho2CghFbnZFbnRyeRIQCgNrZXkYASABKAlSA2tleRIUCg'
    'V2YWx1ZRgCIAEoCVIFdmFsdWU6AjgB');

@$core.Deprecated('Use workflowInfoDescriptor instead')
const WorkflowInfo$json = {
  '1': 'WorkflowInfo',
  '2': [
    {'1': 'run_id', '3': 1, '4': 1, '5': 9, '10': 'runId'},
    {'1': 'name', '3': 2, '4': 1, '5': 9, '10': 'name'},
    {'1': 'path', '3': 3, '4': 1, '5': 9, '10': 'path'},
    {'1': 'version', '3': 4, '4': 1, '5': 9, '10': 'version'},
    {
      '1': 'started_at',
      '3': 5,
      '4': 1,
      '5': 11,
      '6': '.google.protobuf.Timestamp',
      '10': 'startedAt'
    },
  ],
};

/// Descriptor for `WorkflowInfo`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List workflowInfoDescriptor = $convert.base64Decode(
    'CgxXb3JrZmxvd0luZm8SFQoGcnVuX2lkGAEgASgJUgVydW5JZBISCgRuYW1lGAIgASgJUgRuYW'
    '1lEhIKBHBhdGgYAyABKAlSBHBhdGgSGAoHdmVyc2lvbhgEIAEoCVIHdmVyc2lvbhI5CgpzdGFy'
    'dGVkX2F0GAUgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcFIJc3RhcnRlZEF0');

@$core.Deprecated('Use executeOptionsDescriptor instead')
const ExecuteOptions$json = {
  '1': 'ExecuteOptions',
  '2': [
    {'1': 'deadline_ms', '3': 1, '4': 1, '5': 3, '10': 'deadlineMs'},
    {'1': 'stream_logs', '3': 2, '4': 1, '5': 8, '10': 'streamLogs'},
    {'1': 'capture_metrics', '3': 3, '4': 1, '5': 8, '10': 'captureMetrics'},
    {
      '1': 'hints',
      '3': 15,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.ExecuteOptions.HintsEntry',
      '10': 'hints'
    },
  ],
  '3': [ExecuteOptions_HintsEntry$json],
};

@$core.Deprecated('Use executeOptionsDescriptor instead')
const ExecuteOptions_HintsEntry$json = {
  '1': 'HintsEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

/// Descriptor for `ExecuteOptions`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List executeOptionsDescriptor = $convert.base64Decode(
    'Cg5FeGVjdXRlT3B0aW9ucxIfCgtkZWFkbGluZV9tcxgBIAEoA1IKZGVhZGxpbmVNcxIfCgtzdH'
    'JlYW1fbG9ncxgCIAEoCFIKc3RyZWFtTG9ncxInCg9jYXB0dXJlX21ldHJpY3MYAyABKAhSDmNh'
    'cHR1cmVNZXRyaWNzEkAKBWhpbnRzGA8gAygLMiouYmxvay5ydW50aW1lLnYxLkV4ZWN1dGVPcH'
    'Rpb25zLkhpbnRzRW50cnlSBWhpbnRzGjgKCkhpbnRzRW50cnkSEAoDa2V5GAEgASgJUgNrZXkS'
    'FAoFdmFsdWUYAiABKAlSBXZhbHVlOgI4AQ==');

@$core.Deprecated('Use executeResponseDescriptor instead')
const ExecuteResponse$json = {
  '1': 'ExecuteResponse',
  '2': [
    {'1': 'success', '3': 1, '4': 1, '5': 8, '10': 'success'},
    {'1': 'data', '3': 2, '4': 1, '5': 12, '10': 'data'},
    {'1': 'content_type', '3': 3, '4': 1, '5': 9, '10': 'contentType'},
    {
      '1': 'error',
      '3': 4,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.NodeError',
      '10': 'error'
    },
    {'1': 'vars_delta', '3': 5, '4': 1, '5': 12, '10': 'varsDelta'},
    {
      '1': 'logs',
      '3': 6,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.LogLine',
      '10': 'logs'
    },
    {
      '1': 'metrics',
      '3': 7,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.Metrics',
      '10': 'metrics'
    },
  ],
};

/// Descriptor for `ExecuteResponse`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List executeResponseDescriptor = $convert.base64Decode(
    'Cg9FeGVjdXRlUmVzcG9uc2USGAoHc3VjY2VzcxgBIAEoCFIHc3VjY2VzcxISCgRkYXRhGAIgAS'
    'gMUgRkYXRhEiEKDGNvbnRlbnRfdHlwZRgDIAEoCVILY29udGVudFR5cGUSMAoFZXJyb3IYBCAB'
    'KAsyGi5ibG9rLnJ1bnRpbWUudjEuTm9kZUVycm9yUgVlcnJvchIdCgp2YXJzX2RlbHRhGAUgAS'
    'gMUgl2YXJzRGVsdGESLAoEbG9ncxgGIAMoCzIYLmJsb2sucnVudGltZS52MS5Mb2dMaW5lUgRs'
    'b2dzEjIKB21ldHJpY3MYByABKAsyGC5ibG9rLnJ1bnRpbWUudjEuTWV0cmljc1IHbWV0cmljcw'
    '==');

@$core.Deprecated('Use executeEventDescriptor instead')
const ExecuteEvent$json = {
  '1': 'ExecuteEvent',
  '2': [
    {
      '1': 'started',
      '3': 1,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.NodeStarted',
      '9': 0,
      '10': 'started'
    },
    {
      '1': 'log',
      '3': 2,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.LogLine',
      '9': 0,
      '10': 'log'
    },
    {
      '1': 'progress',
      '3': 3,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.Progress',
      '9': 0,
      '10': 'progress'
    },
    {
      '1': 'partial',
      '3': 4,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.PartialResult',
      '9': 0,
      '10': 'partial'
    },
    {
      '1': 'final',
      '3': 5,
      '4': 1,
      '5': 11,
      '6': '.blok.runtime.v1.ExecuteResponse',
      '9': 0,
      '10': 'final'
    },
  ],
  '8': [
    {'1': 'event'},
  ],
};

/// Descriptor for `ExecuteEvent`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List executeEventDescriptor = $convert.base64Decode(
    'CgxFeGVjdXRlRXZlbnQSOAoHc3RhcnRlZBgBIAEoCzIcLmJsb2sucnVudGltZS52MS5Ob2RlU3'
    'RhcnRlZEgAUgdzdGFydGVkEiwKA2xvZxgCIAEoCzIYLmJsb2sucnVudGltZS52MS5Mb2dMaW5l'
    'SABSA2xvZxI3Cghwcm9ncmVzcxgDIAEoCzIZLmJsb2sucnVudGltZS52MS5Qcm9ncmVzc0gAUg'
    'hwcm9ncmVzcxI6CgdwYXJ0aWFsGAQgASgLMh4uYmxvay5ydW50aW1lLnYxLlBhcnRpYWxSZXN1'
    'bHRIAFIHcGFydGlhbBI4CgVmaW5hbBgFIAEoCzIgLmJsb2sucnVudGltZS52MS5FeGVjdXRlUm'
    'VzcG9uc2VIAFIFZmluYWxCBwoFZXZlbnQ=');

@$core.Deprecated('Use nodeStartedDescriptor instead')
const NodeStarted$json = {
  '1': 'NodeStarted',
  '2': [
    {
      '1': 'at',
      '3': 1,
      '4': 1,
      '5': 11,
      '6': '.google.protobuf.Timestamp',
      '10': 'at'
    },
  ],
};

/// Descriptor for `NodeStarted`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List nodeStartedDescriptor = $convert.base64Decode(
    'CgtOb2RlU3RhcnRlZBIqCgJhdBgBIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXBSAm'
    'F0');

@$core.Deprecated('Use progressDescriptor instead')
const Progress$json = {
  '1': 'Progress',
  '2': [
    {'1': 'percent', '3': 1, '4': 1, '5': 1, '10': 'percent'},
    {'1': 'phase', '3': 2, '4': 1, '5': 9, '10': 'phase'},
  ],
};

/// Descriptor for `Progress`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List progressDescriptor = $convert.base64Decode(
    'CghQcm9ncmVzcxIYCgdwZXJjZW50GAEgASgBUgdwZXJjZW50EhQKBXBoYXNlGAIgASgJUgVwaG'
    'FzZQ==');

@$core.Deprecated('Use partialResultDescriptor instead')
const PartialResult$json = {
  '1': 'PartialResult',
  '2': [
    {'1': 'snapshot_json', '3': 1, '4': 1, '5': 12, '10': 'snapshotJson'},
  ],
};

/// Descriptor for `PartialResult`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List partialResultDescriptor = $convert.base64Decode(
    'Cg1QYXJ0aWFsUmVzdWx0EiMKDXNuYXBzaG90X2pzb24YASABKAxSDHNuYXBzaG90SnNvbg==');

@$core.Deprecated('Use logLineDescriptor instead')
const LogLine$json = {
  '1': 'LogLine',
  '2': [
    {
      '1': 'timestamp',
      '3': 1,
      '4': 1,
      '5': 11,
      '6': '.google.protobuf.Timestamp',
      '10': 'timestamp'
    },
    {'1': 'level', '3': 2, '4': 1, '5': 9, '10': 'level'},
    {'1': 'message', '3': 3, '4': 1, '5': 9, '10': 'message'},
    {
      '1': 'attributes',
      '3': 4,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.LogLine.AttributesEntry',
      '10': 'attributes'
    },
  ],
  '3': [LogLine_AttributesEntry$json],
};

@$core.Deprecated('Use logLineDescriptor instead')
const LogLine_AttributesEntry$json = {
  '1': 'AttributesEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

/// Descriptor for `LogLine`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List logLineDescriptor = $convert.base64Decode(
    'CgdMb2dMaW5lEjgKCXRpbWVzdGFtcBgBIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbX'
    'BSCXRpbWVzdGFtcBIUCgVsZXZlbBgCIAEoCVIFbGV2ZWwSGAoHbWVzc2FnZRgDIAEoCVIHbWVz'
    'c2FnZRJICgphdHRyaWJ1dGVzGAQgAygLMiguYmxvay5ydW50aW1lLnYxLkxvZ0xpbmUuQXR0cm'
    'lidXRlc0VudHJ5UgphdHRyaWJ1dGVzGj0KD0F0dHJpYnV0ZXNFbnRyeRIQCgNrZXkYASABKAlS'
    'A2tleRIUCgV2YWx1ZRgCIAEoCVIFdmFsdWU6AjgB');

@$core.Deprecated('Use nodeErrorDescriptor instead')
const NodeError$json = {
  '1': 'NodeError',
  '2': [
    {'1': 'code', '3': 1, '4': 1, '5': 9, '10': 'code'},
    {
      '1': 'category',
      '3': 2,
      '4': 1,
      '5': 14,
      '6': '.blok.runtime.v1.ErrorCategory',
      '10': 'category'
    },
    {
      '1': 'severity',
      '3': 3,
      '4': 1,
      '5': 14,
      '6': '.blok.runtime.v1.ErrorSeverity',
      '10': 'severity'
    },
    {'1': 'node', '3': 4, '4': 1, '5': 9, '10': 'node'},
    {'1': 'sdk', '3': 5, '4': 1, '5': 9, '10': 'sdk'},
    {'1': 'sdk_version', '3': 6, '4': 1, '5': 9, '10': 'sdkVersion'},
    {'1': 'runtime_kind', '3': 7, '4': 1, '5': 9, '10': 'runtimeKind'},
    {
      '1': 'at',
      '3': 8,
      '4': 1,
      '5': 11,
      '6': '.google.protobuf.Timestamp',
      '10': 'at'
    },
    {'1': 'message', '3': 9, '4': 1, '5': 9, '10': 'message'},
    {'1': 'description', '3': 10, '4': 1, '5': 9, '10': 'description'},
    {'1': 'remediation', '3': 11, '4': 1, '5': 9, '10': 'remediation'},
    {'1': 'doc_url', '3': 12, '4': 1, '5': 9, '10': 'docUrl'},
    {
      '1': 'causes',
      '3': 13,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.NodeError',
      '10': 'causes'
    },
    {'1': 'stack', '3': 14, '4': 1, '5': 9, '10': 'stack'},
    {
      '1': 'context_snapshot_json',
      '3': 15,
      '4': 1,
      '5': 12,
      '10': 'contextSnapshotJson'
    },
    {'1': 'http_status', '3': 16, '4': 1, '5': 5, '10': 'httpStatus'},
    {'1': 'retryable', '3': 17, '4': 1, '5': 8, '10': 'retryable'},
    {'1': 'retry_after_ms', '3': 18, '4': 1, '5': 3, '10': 'retryAfterMs'},
    {'1': 'details_json', '3': 19, '4': 1, '5': 12, '10': 'detailsJson'},
  ],
};

/// Descriptor for `NodeError`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List nodeErrorDescriptor = $convert.base64Decode(
    'CglOb2RlRXJyb3ISEgoEY29kZRgBIAEoCVIEY29kZRI6CghjYXRlZ29yeRgCIAEoDjIeLmJsb2'
    'sucnVudGltZS52MS5FcnJvckNhdGVnb3J5UghjYXRlZ29yeRI6CghzZXZlcml0eRgDIAEoDjIe'
    'LmJsb2sucnVudGltZS52MS5FcnJvclNldmVyaXR5UghzZXZlcml0eRISCgRub2RlGAQgASgJUg'
    'Rub2RlEhAKA3NkaxgFIAEoCVIDc2RrEh8KC3Nka192ZXJzaW9uGAYgASgJUgpzZGtWZXJzaW9u'
    'EiEKDHJ1bnRpbWVfa2luZBgHIAEoCVILcnVudGltZUtpbmQSKgoCYXQYCCABKAsyGi5nb29nbG'
    'UucHJvdG9idWYuVGltZXN0YW1wUgJhdBIYCgdtZXNzYWdlGAkgASgJUgdtZXNzYWdlEiAKC2Rl'
    'c2NyaXB0aW9uGAogASgJUgtkZXNjcmlwdGlvbhIgCgtyZW1lZGlhdGlvbhgLIAEoCVILcmVtZW'
    'RpYXRpb24SFwoHZG9jX3VybBgMIAEoCVIGZG9jVXJsEjIKBmNhdXNlcxgNIAMoCzIaLmJsb2su'
    'cnVudGltZS52MS5Ob2RlRXJyb3JSBmNhdXNlcxIUCgVzdGFjaxgOIAEoCVIFc3RhY2sSMgoVY2'
    '9udGV4dF9zbmFwc2hvdF9qc29uGA8gASgMUhNjb250ZXh0U25hcHNob3RKc29uEh8KC2h0dHBf'
    'c3RhdHVzGBAgASgFUgpodHRwU3RhdHVzEhwKCXJldHJ5YWJsZRgRIAEoCFIJcmV0cnlhYmxlEi'
    'QKDnJldHJ5X2FmdGVyX21zGBIgASgDUgxyZXRyeUFmdGVyTXMSIQoMZGV0YWlsc19qc29uGBMg'
    'ASgMUgtkZXRhaWxzSnNvbg==');

@$core.Deprecated('Use listNodesRequestDescriptor instead')
const ListNodesRequest$json = {
  '1': 'ListNodesRequest',
};

/// Descriptor for `ListNodesRequest`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List listNodesRequestDescriptor =
    $convert.base64Decode('ChBMaXN0Tm9kZXNSZXF1ZXN0');

@$core.Deprecated('Use listNodesResponseDescriptor instead')
const ListNodesResponse$json = {
  '1': 'ListNodesResponse',
  '2': [
    {
      '1': 'nodes',
      '3': 1,
      '4': 3,
      '5': 11,
      '6': '.blok.runtime.v1.NodeDescriptor',
      '10': 'nodes'
    },
    {'1': 'sdk_name', '3': 2, '4': 1, '5': 9, '10': 'sdkName'},
    {'1': 'sdk_version', '3': 3, '4': 1, '5': 9, '10': 'sdkVersion'},
    {'1': 'proto_version', '3': 4, '4': 1, '5': 9, '10': 'protoVersion'},
    {'1': 'capabilities', '3': 5, '4': 3, '5': 9, '10': 'capabilities'},
  ],
};

/// Descriptor for `ListNodesResponse`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List listNodesResponseDescriptor = $convert.base64Decode(
    'ChFMaXN0Tm9kZXNSZXNwb25zZRI1CgVub2RlcxgBIAMoCzIfLmJsb2sucnVudGltZS52MS5Ob2'
    'RlRGVzY3JpcHRvclIFbm9kZXMSGQoIc2RrX25hbWUYAiABKAlSB3Nka05hbWUSHwoLc2RrX3Zl'
    'cnNpb24YAyABKAlSCnNka1ZlcnNpb24SIwoNcHJvdG9fdmVyc2lvbhgEIAEoCVIMcHJvdG9WZX'
    'JzaW9uEiIKDGNhcGFiaWxpdGllcxgFIAMoCVIMY2FwYWJpbGl0aWVz');

@$core.Deprecated('Use nodeDescriptorDescriptor instead')
const NodeDescriptor$json = {
  '1': 'NodeDescriptor',
  '2': [
    {'1': 'name', '3': 1, '4': 1, '5': 9, '10': 'name'},
    {'1': 'description', '3': 2, '4': 1, '5': 9, '10': 'description'},
    {
      '1': 'input_schema_json',
      '3': 3,
      '4': 1,
      '5': 12,
      '10': 'inputSchemaJson'
    },
    {
      '1': 'output_schema_json',
      '3': 4,
      '4': 1,
      '5': 12,
      '10': 'outputSchemaJson'
    },
    {'1': 'tags', '3': 5, '4': 3, '5': 9, '10': 'tags'},
    {
      '1': 'capability_manifest_json',
      '3': 6,
      '4': 1,
      '5': 12,
      '10': 'capabilityManifestJson'
    },
  ],
};

/// Descriptor for `NodeDescriptor`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List nodeDescriptorDescriptor = $convert.base64Decode(
    'Cg5Ob2RlRGVzY3JpcHRvchISCgRuYW1lGAEgASgJUgRuYW1lEiAKC2Rlc2NyaXB0aW9uGAIgAS'
    'gJUgtkZXNjcmlwdGlvbhIqChFpbnB1dF9zY2hlbWFfanNvbhgDIAEoDFIPaW5wdXRTY2hlbWFK'
    'c29uEiwKEm91dHB1dF9zY2hlbWFfanNvbhgEIAEoDFIQb3V0cHV0U2NoZW1hSnNvbhISCgR0YW'
    'dzGAUgAygJUgR0YWdzEjgKGGNhcGFiaWxpdHlfbWFuaWZlc3RfanNvbhgGIAEoDFIWY2FwYWJp'
    'bGl0eU1hbmlmZXN0SnNvbg==');

@$core.Deprecated('Use healthRequestDescriptor instead')
const HealthRequest$json = {
  '1': 'HealthRequest',
  '2': [
    {'1': 'service', '3': 1, '4': 1, '5': 9, '10': 'service'},
  ],
};

/// Descriptor for `HealthRequest`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List healthRequestDescriptor = $convert
    .base64Decode('Cg1IZWFsdGhSZXF1ZXN0EhgKB3NlcnZpY2UYASABKAlSB3NlcnZpY2U=');

@$core.Deprecated('Use healthResponseDescriptor instead')
const HealthResponse$json = {
  '1': 'HealthResponse',
  '2': [
    {
      '1': 'status',
      '3': 1,
      '4': 1,
      '5': 14,
      '6': '.blok.runtime.v1.HealthResponse.Status',
      '10': 'status'
    },
    {'1': 'sdk_version', '3': 2, '4': 1, '5': 9, '10': 'sdkVersion'},
    {'1': 'registered_nodes', '3': 3, '4': 3, '5': 9, '10': 'registeredNodes'},
  ],
  '4': [HealthResponse_Status$json],
};

@$core.Deprecated('Use healthResponseDescriptor instead')
const HealthResponse_Status$json = {
  '1': 'Status',
  '2': [
    {'1': 'UNKNOWN', '2': 0},
    {'1': 'SERVING', '2': 1},
    {'1': 'NOT_SERVING', '2': 2},
  ],
};

/// Descriptor for `HealthResponse`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List healthResponseDescriptor = $convert.base64Decode(
    'Cg5IZWFsdGhSZXNwb25zZRI+CgZzdGF0dXMYASABKA4yJi5ibG9rLnJ1bnRpbWUudjEuSGVhbH'
    'RoUmVzcG9uc2UuU3RhdHVzUgZzdGF0dXMSHwoLc2RrX3ZlcnNpb24YAiABKAlSCnNka1ZlcnNp'
    'b24SKQoQcmVnaXN0ZXJlZF9ub2RlcxgDIAMoCVIPcmVnaXN0ZXJlZE5vZGVzIjMKBlN0YXR1cx'
    'ILCgdVTktOT1dOEAASCwoHU0VSVklORxABEg8KC05PVF9TRVJWSU5HEAI=');

@$core.Deprecated('Use metricsDescriptor instead')
const Metrics$json = {
  '1': 'Metrics',
  '2': [
    {'1': 'duration_ms', '3': 1, '4': 1, '5': 1, '10': 'durationMs'},
    {'1': 'cpu_ms', '3': 2, '4': 1, '5': 1, '10': 'cpuMs'},
    {'1': 'memory_bytes', '3': 3, '4': 1, '5': 3, '10': 'memoryBytes'},
    {'1': 'request_bytes', '3': 4, '4': 1, '5': 3, '10': 'requestBytes'},
    {'1': 'response_bytes', '3': 5, '4': 1, '5': 3, '10': 'responseBytes'},
  ],
};

/// Descriptor for `Metrics`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List metricsDescriptor = $convert.base64Decode(
    'CgdNZXRyaWNzEh8KC2R1cmF0aW9uX21zGAEgASgBUgpkdXJhdGlvbk1zEhUKBmNwdV9tcxgCIA'
    'EoAVIFY3B1TXMSIQoMbWVtb3J5X2J5dGVzGAMgASgDUgttZW1vcnlCeXRlcxIjCg1yZXF1ZXN0'
    'X2J5dGVzGAQgASgDUgxyZXF1ZXN0Qnl0ZXMSJQoOcmVzcG9uc2VfYnl0ZXMYBSABKANSDXJlc3'
    'BvbnNlQnl0ZXM=');
