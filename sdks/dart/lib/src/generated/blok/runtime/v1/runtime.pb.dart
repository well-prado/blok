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

import 'package:fixnum/fixnum.dart' as $fixnum;
import 'package:protobuf/protobuf.dart' as $pb;

import '../../../google/protobuf/timestamp.pb.dart' as $1;
import 'runtime.pbenum.dart';

export 'runtime.pbenum.dart';

class ExecuteRequest extends $pb.GeneratedMessage {
  factory ExecuteRequest({
    NodeRef? node,
    $core.List<$core.int>? inputs,
    StepInfo? step,
    TriggerInfo? trigger,
    RuntimeState? state,
    WorkflowInfo? workflow,
    ExecuteOptions? options,
  }) {
    final $result = create();
    if (node != null) {
      $result.node = node;
    }
    if (inputs != null) {
      $result.inputs = inputs;
    }
    if (step != null) {
      $result.step = step;
    }
    if (trigger != null) {
      $result.trigger = trigger;
    }
    if (state != null) {
      $result.state = state;
    }
    if (workflow != null) {
      $result.workflow = workflow;
    }
    if (options != null) {
      $result.options = options;
    }
    return $result;
  }
  ExecuteRequest._() : super();
  factory ExecuteRequest.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory ExecuteRequest.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ExecuteRequest',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOM<NodeRef>(1, _omitFieldNames ? '' : 'node', subBuilder: NodeRef.create)
    ..a<$core.List<$core.int>>(
        2, _omitFieldNames ? '' : 'inputs', $pb.PbFieldType.OY)
    ..aOM<StepInfo>(3, _omitFieldNames ? '' : 'step',
        subBuilder: StepInfo.create)
    ..aOM<TriggerInfo>(4, _omitFieldNames ? '' : 'trigger',
        subBuilder: TriggerInfo.create)
    ..aOM<RuntimeState>(5, _omitFieldNames ? '' : 'state',
        subBuilder: RuntimeState.create)
    ..aOM<WorkflowInfo>(6, _omitFieldNames ? '' : 'workflow',
        subBuilder: WorkflowInfo.create)
    ..aOM<ExecuteOptions>(7, _omitFieldNames ? '' : 'options',
        subBuilder: ExecuteOptions.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  ExecuteRequest clone() => ExecuteRequest()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  ExecuteRequest copyWith(void Function(ExecuteRequest) updates) =>
      super.copyWith((message) => updates(message as ExecuteRequest))
          as ExecuteRequest;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static ExecuteRequest create() => ExecuteRequest._();
  ExecuteRequest createEmptyInstance() => create();
  static $pb.PbList<ExecuteRequest> createRepeated() =>
      $pb.PbList<ExecuteRequest>();
  @$core.pragma('dart2js:noInline')
  static ExecuteRequest getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<ExecuteRequest>(create);
  static ExecuteRequest? _defaultInstance;

  /// Identification: which node, what type, what version.
  @$pb.TagNumber(1)
  NodeRef get node => $_getN(0);
  @$pb.TagNumber(1)
  set node(NodeRef v) {
    setField(1, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasNode() => $_has(0);
  @$pb.TagNumber(1)
  void clearNode() => clearField(1);
  @$pb.TagNumber(1)
  NodeRef ensureNode() => $_ensure(0);

  /// The node's own resolved inputs. Already mapped (js/, ${...} resolved).
  /// Bytes-encoded JSON: SDKs JSON-decode lazily. NEVER wrapped in {inputs:...}.
  @$pb.TagNumber(2)
  $core.List<$core.int> get inputs => $_getN(1);
  @$pb.TagNumber(2)
  set inputs($core.List<$core.int> v) {
    $_setBytes(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasInputs() => $_has(1);
  @$pb.TagNumber(2)
  void clearInputs() => clearField(2);

  /// Where in the workflow this node sits.
  @$pb.TagNumber(3)
  StepInfo get step => $_getN(2);
  @$pb.TagNumber(3)
  set step(StepInfo v) {
    setField(3, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasStep() => $_has(2);
  @$pb.TagNumber(3)
  void clearStep() => clearField(3);
  @$pb.TagNumber(3)
  StepInfo ensureStep() => $_ensure(2);

  /// The originating workflow trigger (read-only context for nodes).
  @$pb.TagNumber(4)
  TriggerInfo get trigger => $_getN(3);
  @$pb.TagNumber(4)
  set trigger(TriggerInfo v) {
    setField(4, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasTrigger() => $_has(3);
  @$pb.TagNumber(4)
  void clearTrigger() => clearField(4);
  @$pb.TagNumber(4)
  TriggerInfo ensureTrigger() => $_ensure(3);

  /// Mutable state: previous step output, persistent vars, env mirror.
  @$pb.TagNumber(5)
  RuntimeState get state => $_getN(4);
  @$pb.TagNumber(5)
  set state(RuntimeState v) {
    setField(5, v);
  }

  @$pb.TagNumber(5)
  $core.bool hasState() => $_has(4);
  @$pb.TagNumber(5)
  void clearState() => clearField(5);
  @$pb.TagNumber(5)
  RuntimeState ensureState() => $_ensure(4);

  /// Identity of the parent workflow run.
  @$pb.TagNumber(6)
  WorkflowInfo get workflow => $_getN(5);
  @$pb.TagNumber(6)
  set workflow(WorkflowInfo v) {
    setField(6, v);
  }

  @$pb.TagNumber(6)
  $core.bool hasWorkflow() => $_has(5);
  @$pb.TagNumber(6)
  void clearWorkflow() => clearField(6);
  @$pb.TagNumber(6)
  WorkflowInfo ensureWorkflow() => $_ensure(5);

  /// Per-call options (deadline, streaming opt-in).
  @$pb.TagNumber(7)
  ExecuteOptions get options => $_getN(6);
  @$pb.TagNumber(7)
  set options(ExecuteOptions v) {
    setField(7, v);
  }

  @$pb.TagNumber(7)
  $core.bool hasOptions() => $_has(6);
  @$pb.TagNumber(7)
  void clearOptions() => clearField(7);
  @$pb.TagNumber(7)
  ExecuteOptions ensureOptions() => $_ensure(6);
}

class NodeRef extends $pb.GeneratedMessage {
  factory NodeRef({
    $core.String? name,
    $core.String? type,
    $core.String? version,
  }) {
    final $result = create();
    if (name != null) {
      $result.name = name;
    }
    if (type != null) {
      $result.type = type;
    }
    if (version != null) {
      $result.version = version;
    }
    return $result;
  }
  NodeRef._() : super();
  factory NodeRef.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory NodeRef.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'NodeRef',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'name')
    ..aOS(2, _omitFieldNames ? '' : 'type')
    ..aOS(3, _omitFieldNames ? '' : 'version')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  NodeRef clone() => NodeRef()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  NodeRef copyWith(void Function(NodeRef) updates) =>
      super.copyWith((message) => updates(message as NodeRef)) as NodeRef;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static NodeRef create() => NodeRef._();
  NodeRef createEmptyInstance() => create();
  static $pb.PbList<NodeRef> createRepeated() => $pb.PbList<NodeRef>();
  @$core.pragma('dart2js:noInline')
  static NodeRef getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<NodeRef>(create);
  static NodeRef? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get name => $_getSZ(0);
  @$pb.TagNumber(1)
  set name($core.String v) {
    $_setString(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasName() => $_has(0);
  @$pb.TagNumber(1)
  void clearName() => clearField(1);

  @$pb.TagNumber(2)
  $core.String get type => $_getSZ(1);
  @$pb.TagNumber(2)
  set type($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasType() => $_has(1);
  @$pb.TagNumber(2)
  void clearType() => clearField(2);

  @$pb.TagNumber(3)
  $core.String get version => $_getSZ(2);
  @$pb.TagNumber(3)
  set version($core.String v) {
    $_setString(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasVersion() => $_has(2);
  @$pb.TagNumber(3)
  void clearVersion() => clearField(3);
}

class StepInfo extends $pb.GeneratedMessage {
  factory StepInfo({
    $core.String? name,
    $core.int? index,
    $core.int? total,
    $core.int? depth,
  }) {
    final $result = create();
    if (name != null) {
      $result.name = name;
    }
    if (index != null) {
      $result.index = index;
    }
    if (total != null) {
      $result.total = total;
    }
    if (depth != null) {
      $result.depth = depth;
    }
    return $result;
  }
  StepInfo._() : super();
  factory StepInfo.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory StepInfo.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'StepInfo',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'name')
    ..a<$core.int>(2, _omitFieldNames ? '' : 'index', $pb.PbFieldType.O3)
    ..a<$core.int>(3, _omitFieldNames ? '' : 'total', $pb.PbFieldType.O3)
    ..a<$core.int>(4, _omitFieldNames ? '' : 'depth', $pb.PbFieldType.O3)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  StepInfo clone() => StepInfo()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  StepInfo copyWith(void Function(StepInfo) updates) =>
      super.copyWith((message) => updates(message as StepInfo)) as StepInfo;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static StepInfo create() => StepInfo._();
  StepInfo createEmptyInstance() => create();
  static $pb.PbList<StepInfo> createRepeated() => $pb.PbList<StepInfo>();
  @$core.pragma('dart2js:noInline')
  static StepInfo getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<StepInfo>(create);
  static StepInfo? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get name => $_getSZ(0);
  @$pb.TagNumber(1)
  set name($core.String v) {
    $_setString(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasName() => $_has(0);
  @$pb.TagNumber(1)
  void clearName() => clearField(1);

  @$pb.TagNumber(2)
  $core.int get index => $_getIZ(1);
  @$pb.TagNumber(2)
  set index($core.int v) {
    $_setSignedInt32(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasIndex() => $_has(1);
  @$pb.TagNumber(2)
  void clearIndex() => clearField(2);

  @$pb.TagNumber(3)
  $core.int get total => $_getIZ(2);
  @$pb.TagNumber(3)
  set total($core.int v) {
    $_setSignedInt32(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasTotal() => $_has(2);
  @$pb.TagNumber(3)
  void clearTotal() => clearField(3);

  @$pb.TagNumber(4)
  $core.int get depth => $_getIZ(3);
  @$pb.TagNumber(4)
  set depth($core.int v) {
    $_setSignedInt32(3, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasDepth() => $_has(3);
  @$pb.TagNumber(4)
  void clearDepth() => clearField(4);
}

class TriggerInfo extends $pb.GeneratedMessage {
  factory TriggerInfo({
    $core.List<$core.int>? body,
    $core.Map<$core.String, $core.String>? headers,
    $core.Map<$core.String, $core.String>? params,
    $core.Map<$core.String, $core.String>? query,
    $core.Map<$core.String, $core.String>? cookies,
    $core.String? method,
    $core.String? url,
    $core.String? baseUrl,
    $core.String? triggerKind,
  }) {
    final $result = create();
    if (body != null) {
      $result.body = body;
    }
    if (headers != null) {
      $result.headers.addAll(headers);
    }
    if (params != null) {
      $result.params.addAll(params);
    }
    if (query != null) {
      $result.query.addAll(query);
    }
    if (cookies != null) {
      $result.cookies.addAll(cookies);
    }
    if (method != null) {
      $result.method = method;
    }
    if (url != null) {
      $result.url = url;
    }
    if (baseUrl != null) {
      $result.baseUrl = baseUrl;
    }
    if (triggerKind != null) {
      $result.triggerKind = triggerKind;
    }
    return $result;
  }
  TriggerInfo._() : super();
  factory TriggerInfo.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory TriggerInfo.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'TriggerInfo',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..a<$core.List<$core.int>>(
        1, _omitFieldNames ? '' : 'body', $pb.PbFieldType.OY)
    ..m<$core.String, $core.String>(2, _omitFieldNames ? '' : 'headers',
        entryClassName: 'TriggerInfo.HeadersEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..m<$core.String, $core.String>(3, _omitFieldNames ? '' : 'params',
        entryClassName: 'TriggerInfo.ParamsEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..m<$core.String, $core.String>(4, _omitFieldNames ? '' : 'query',
        entryClassName: 'TriggerInfo.QueryEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..m<$core.String, $core.String>(5, _omitFieldNames ? '' : 'cookies',
        entryClassName: 'TriggerInfo.CookiesEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..aOS(6, _omitFieldNames ? '' : 'method')
    ..aOS(7, _omitFieldNames ? '' : 'url')
    ..aOS(8, _omitFieldNames ? '' : 'baseUrl')
    ..aOS(9, _omitFieldNames ? '' : 'triggerKind')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  TriggerInfo clone() => TriggerInfo()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  TriggerInfo copyWith(void Function(TriggerInfo) updates) =>
      super.copyWith((message) => updates(message as TriggerInfo))
          as TriggerInfo;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static TriggerInfo create() => TriggerInfo._();
  TriggerInfo createEmptyInstance() => create();
  static $pb.PbList<TriggerInfo> createRepeated() => $pb.PbList<TriggerInfo>();
  @$core.pragma('dart2js:noInline')
  static TriggerInfo getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<TriggerInfo>(create);
  static TriggerInfo? _defaultInstance;

  /// Snapshot of the trigger that started the workflow. Read-only for nodes.
  @$pb.TagNumber(1)
  $core.List<$core.int> get body => $_getN(0);
  @$pb.TagNumber(1)
  set body($core.List<$core.int> v) {
    $_setBytes(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasBody() => $_has(0);
  @$pb.TagNumber(1)
  void clearBody() => clearField(1);

  @$pb.TagNumber(2)
  $core.Map<$core.String, $core.String> get headers => $_getMap(1);

  @$pb.TagNumber(3)
  $core.Map<$core.String, $core.String> get params => $_getMap(2);

  @$pb.TagNumber(4)
  $core.Map<$core.String, $core.String> get query => $_getMap(3);

  @$pb.TagNumber(5)
  $core.Map<$core.String, $core.String> get cookies => $_getMap(4);

  @$pb.TagNumber(6)
  $core.String get method => $_getSZ(5);
  @$pb.TagNumber(6)
  set method($core.String v) {
    $_setString(5, v);
  }

  @$pb.TagNumber(6)
  $core.bool hasMethod() => $_has(5);
  @$pb.TagNumber(6)
  void clearMethod() => clearField(6);

  @$pb.TagNumber(7)
  $core.String get url => $_getSZ(6);
  @$pb.TagNumber(7)
  set url($core.String v) {
    $_setString(6, v);
  }

  @$pb.TagNumber(7)
  $core.bool hasUrl() => $_has(6);
  @$pb.TagNumber(7)
  void clearUrl() => clearField(7);

  @$pb.TagNumber(8)
  $core.String get baseUrl => $_getSZ(7);
  @$pb.TagNumber(8)
  set baseUrl($core.String v) {
    $_setString(7, v);
  }

  @$pb.TagNumber(8)
  $core.bool hasBaseUrl() => $_has(7);
  @$pb.TagNumber(8)
  void clearBaseUrl() => clearField(8);

  @$pb.TagNumber(9)
  $core.String get triggerKind => $_getSZ(8);
  @$pb.TagNumber(9)
  set triggerKind($core.String v) {
    $_setString(8, v);
  }

  @$pb.TagNumber(9)
  $core.bool hasTriggerKind() => $_has(8);
  @$pb.TagNumber(9)
  void clearTriggerKind() => clearField(9);
}

class RuntimeState extends $pb.GeneratedMessage {
  factory RuntimeState({
    $core.List<$core.int>? previousOutput,
    $core.List<$core.int>? vars,
    $core.Map<$core.String, $core.String>? env,
  }) {
    final $result = create();
    if (previousOutput != null) {
      $result.previousOutput = previousOutput;
    }
    if (vars != null) {
      $result.vars = vars;
    }
    if (env != null) {
      $result.env.addAll(env);
    }
    return $result;
  }
  RuntimeState._() : super();
  factory RuntimeState.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory RuntimeState.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'RuntimeState',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..a<$core.List<$core.int>>(
        1, _omitFieldNames ? '' : 'previousOutput', $pb.PbFieldType.OY)
    ..a<$core.List<$core.int>>(
        2, _omitFieldNames ? '' : 'vars', $pb.PbFieldType.OY)
    ..m<$core.String, $core.String>(3, _omitFieldNames ? '' : 'env',
        entryClassName: 'RuntimeState.EnvEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  RuntimeState clone() => RuntimeState()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  RuntimeState copyWith(void Function(RuntimeState) updates) =>
      super.copyWith((message) => updates(message as RuntimeState))
          as RuntimeState;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static RuntimeState create() => RuntimeState._();
  RuntimeState createEmptyInstance() => create();
  static $pb.PbList<RuntimeState> createRepeated() =>
      $pb.PbList<RuntimeState>();
  @$core.pragma('dart2js:noInline')
  static RuntimeState getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<RuntimeState>(create);
  static RuntimeState? _defaultInstance;

  /// Output of the previous step. Named explicitly so LLM-authored nodes stop
  /// confusing it with vars. Bytes-encoded JSON.
  @$pb.TagNumber(1)
  $core.List<$core.int> get previousOutput => $_getN(0);
  @$pb.TagNumber(1)
  set previousOutput($core.List<$core.int> v) {
    $_setBytes(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasPreviousOutput() => $_has(0);
  @$pb.TagNumber(1)
  void clearPreviousOutput() => clearField(1);

  /// Workflow-scoped persistent storage (set_var: true on prior steps).
  /// Bytes-encoded JSON map<string, any>.
  @$pb.TagNumber(2)
  $core.List<$core.int> get vars => $_getN(1);
  @$pb.TagNumber(2)
  set vars($core.List<$core.int> v) {
    $_setBytes(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasVars() => $_has(1);
  @$pb.TagNumber(2)
  void clearVars() => clearField(2);

  /// String→string env mirror.
  @$pb.TagNumber(3)
  $core.Map<$core.String, $core.String> get env => $_getMap(2);
}

class WorkflowInfo extends $pb.GeneratedMessage {
  factory WorkflowInfo({
    $core.String? runId,
    $core.String? name,
    $core.String? path,
    $core.String? version,
    $1.Timestamp? startedAt,
  }) {
    final $result = create();
    if (runId != null) {
      $result.runId = runId;
    }
    if (name != null) {
      $result.name = name;
    }
    if (path != null) {
      $result.path = path;
    }
    if (version != null) {
      $result.version = version;
    }
    if (startedAt != null) {
      $result.startedAt = startedAt;
    }
    return $result;
  }
  WorkflowInfo._() : super();
  factory WorkflowInfo.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory WorkflowInfo.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'WorkflowInfo',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'runId')
    ..aOS(2, _omitFieldNames ? '' : 'name')
    ..aOS(3, _omitFieldNames ? '' : 'path')
    ..aOS(4, _omitFieldNames ? '' : 'version')
    ..aOM<$1.Timestamp>(5, _omitFieldNames ? '' : 'startedAt',
        subBuilder: $1.Timestamp.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  WorkflowInfo clone() => WorkflowInfo()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  WorkflowInfo copyWith(void Function(WorkflowInfo) updates) =>
      super.copyWith((message) => updates(message as WorkflowInfo))
          as WorkflowInfo;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static WorkflowInfo create() => WorkflowInfo._();
  WorkflowInfo createEmptyInstance() => create();
  static $pb.PbList<WorkflowInfo> createRepeated() =>
      $pb.PbList<WorkflowInfo>();
  @$core.pragma('dart2js:noInline')
  static WorkflowInfo getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<WorkflowInfo>(create);
  static WorkflowInfo? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get runId => $_getSZ(0);
  @$pb.TagNumber(1)
  set runId($core.String v) {
    $_setString(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasRunId() => $_has(0);
  @$pb.TagNumber(1)
  void clearRunId() => clearField(1);

  @$pb.TagNumber(2)
  $core.String get name => $_getSZ(1);
  @$pb.TagNumber(2)
  set name($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasName() => $_has(1);
  @$pb.TagNumber(2)
  void clearName() => clearField(2);

  @$pb.TagNumber(3)
  $core.String get path => $_getSZ(2);
  @$pb.TagNumber(3)
  set path($core.String v) {
    $_setString(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasPath() => $_has(2);
  @$pb.TagNumber(3)
  void clearPath() => clearField(3);

  @$pb.TagNumber(4)
  $core.String get version => $_getSZ(3);
  @$pb.TagNumber(4)
  set version($core.String v) {
    $_setString(3, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasVersion() => $_has(3);
  @$pb.TagNumber(4)
  void clearVersion() => clearField(4);

  @$pb.TagNumber(5)
  $1.Timestamp get startedAt => $_getN(4);
  @$pb.TagNumber(5)
  set startedAt($1.Timestamp v) {
    setField(5, v);
  }

  @$pb.TagNumber(5)
  $core.bool hasStartedAt() => $_has(4);
  @$pb.TagNumber(5)
  void clearStartedAt() => clearField(5);
  @$pb.TagNumber(5)
  $1.Timestamp ensureStartedAt() => $_ensure(4);
}

class ExecuteOptions extends $pb.GeneratedMessage {
  factory ExecuteOptions({
    $fixnum.Int64? deadlineMs,
    $core.bool? streamLogs,
    $core.bool? captureMetrics,
    $core.Map<$core.String, $core.String>? hints,
  }) {
    final $result = create();
    if (deadlineMs != null) {
      $result.deadlineMs = deadlineMs;
    }
    if (streamLogs != null) {
      $result.streamLogs = streamLogs;
    }
    if (captureMetrics != null) {
      $result.captureMetrics = captureMetrics;
    }
    if (hints != null) {
      $result.hints.addAll(hints);
    }
    return $result;
  }
  ExecuteOptions._() : super();
  factory ExecuteOptions.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory ExecuteOptions.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ExecuteOptions',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aInt64(1, _omitFieldNames ? '' : 'deadlineMs')
    ..aOB(2, _omitFieldNames ? '' : 'streamLogs')
    ..aOB(3, _omitFieldNames ? '' : 'captureMetrics')
    ..m<$core.String, $core.String>(15, _omitFieldNames ? '' : 'hints',
        entryClassName: 'ExecuteOptions.HintsEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  ExecuteOptions clone() => ExecuteOptions()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  ExecuteOptions copyWith(void Function(ExecuteOptions) updates) =>
      super.copyWith((message) => updates(message as ExecuteOptions))
          as ExecuteOptions;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static ExecuteOptions create() => ExecuteOptions._();
  ExecuteOptions createEmptyInstance() => create();
  static $pb.PbList<ExecuteOptions> createRepeated() =>
      $pb.PbList<ExecuteOptions>();
  @$core.pragma('dart2js:noInline')
  static ExecuteOptions getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<ExecuteOptions>(create);
  static ExecuteOptions? _defaultInstance;

  @$pb.TagNumber(1)
  $fixnum.Int64 get deadlineMs => $_getI64(0);
  @$pb.TagNumber(1)
  set deadlineMs($fixnum.Int64 v) {
    $_setInt64(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasDeadlineMs() => $_has(0);
  @$pb.TagNumber(1)
  void clearDeadlineMs() => clearField(1);

  @$pb.TagNumber(2)
  $core.bool get streamLogs => $_getBF(1);
  @$pb.TagNumber(2)
  set streamLogs($core.bool v) {
    $_setBool(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasStreamLogs() => $_has(1);
  @$pb.TagNumber(2)
  void clearStreamLogs() => clearField(2);

  @$pb.TagNumber(3)
  $core.bool get captureMetrics => $_getBF(2);
  @$pb.TagNumber(3)
  set captureMetrics($core.bool v) {
    $_setBool(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasCaptureMetrics() => $_has(2);
  @$pb.TagNumber(3)
  void clearCaptureMetrics() => clearField(3);

  /// Reserved for future routing/affinity hints without bumping schema.
  @$pb.TagNumber(15)
  $core.Map<$core.String, $core.String> get hints => $_getMap(3);
}

class ExecuteResponse extends $pb.GeneratedMessage {
  factory ExecuteResponse({
    $core.bool? success,
    $core.List<$core.int>? data,
    $core.String? contentType,
    NodeError? error,
    $core.List<$core.int>? varsDelta,
    $core.Iterable<LogLine>? logs,
    Metrics? metrics,
  }) {
    final $result = create();
    if (success != null) {
      $result.success = success;
    }
    if (data != null) {
      $result.data = data;
    }
    if (contentType != null) {
      $result.contentType = contentType;
    }
    if (error != null) {
      $result.error = error;
    }
    if (varsDelta != null) {
      $result.varsDelta = varsDelta;
    }
    if (logs != null) {
      $result.logs.addAll(logs);
    }
    if (metrics != null) {
      $result.metrics = metrics;
    }
    return $result;
  }
  ExecuteResponse._() : super();
  factory ExecuteResponse.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory ExecuteResponse.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ExecuteResponse',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOB(1, _omitFieldNames ? '' : 'success')
    ..a<$core.List<$core.int>>(
        2, _omitFieldNames ? '' : 'data', $pb.PbFieldType.OY)
    ..aOS(3, _omitFieldNames ? '' : 'contentType')
    ..aOM<NodeError>(4, _omitFieldNames ? '' : 'error',
        subBuilder: NodeError.create)
    ..a<$core.List<$core.int>>(
        5, _omitFieldNames ? '' : 'varsDelta', $pb.PbFieldType.OY)
    ..pc<LogLine>(6, _omitFieldNames ? '' : 'logs', $pb.PbFieldType.PM,
        subBuilder: LogLine.create)
    ..aOM<Metrics>(7, _omitFieldNames ? '' : 'metrics',
        subBuilder: Metrics.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  ExecuteResponse clone() => ExecuteResponse()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  ExecuteResponse copyWith(void Function(ExecuteResponse) updates) =>
      super.copyWith((message) => updates(message as ExecuteResponse))
          as ExecuteResponse;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static ExecuteResponse create() => ExecuteResponse._();
  ExecuteResponse createEmptyInstance() => create();
  static $pb.PbList<ExecuteResponse> createRepeated() =>
      $pb.PbList<ExecuteResponse>();
  @$core.pragma('dart2js:noInline')
  static ExecuteResponse getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<ExecuteResponse>(create);
  static ExecuteResponse? _defaultInstance;

  @$pb.TagNumber(1)
  $core.bool get success => $_getBF(0);
  @$pb.TagNumber(1)
  set success($core.bool v) {
    $_setBool(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasSuccess() => $_has(0);
  @$pb.TagNumber(1)
  void clearSuccess() => clearField(1);

  /// The node's primary return value. Bytes-encoded JSON.
  @$pb.TagNumber(2)
  $core.List<$core.int> get data => $_getN(1);
  @$pb.TagNumber(2)
  set data($core.List<$core.int> v) {
    $_setBytes(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasData() => $_has(1);
  @$pb.TagNumber(2)
  void clearData() => clearField(2);

  /// Optional content-type override (default "application/json").
  @$pb.TagNumber(3)
  $core.String get contentType => $_getSZ(2);
  @$pb.TagNumber(3)
  set contentType($core.String v) {
    $_setString(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasContentType() => $_has(2);
  @$pb.TagNumber(3)
  void clearContentType() => clearField(3);

  /// Set iff !success. Always populated on failure (see NodeError).
  @$pb.TagNumber(4)
  NodeError get error => $_getN(3);
  @$pb.TagNumber(4)
  set error(NodeError v) {
    setField(4, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasError() => $_has(3);
  @$pb.TagNumber(4)
  void clearError() => clearField(4);
  @$pb.TagNumber(4)
  NodeError ensureError() => $_ensure(3);

  /// Vars the node wants persisted (merged into ctx.vars on the runner side).
  /// Optional — most nodes leave this empty and rely on workflow-level set_var.
  /// Bytes-encoded JSON map<string, any>.
  @$pb.TagNumber(5)
  $core.List<$core.int> get varsDelta => $_getN(4);
  @$pb.TagNumber(5)
  set varsDelta($core.List<$core.int> v) {
    $_setBytes(4, v);
  }

  @$pb.TagNumber(5)
  $core.bool hasVarsDelta() => $_has(4);
  @$pb.TagNumber(5)
  void clearVarsDelta() => clearField(5);

  /// Tail of logs captured during execution.
  @$pb.TagNumber(6)
  $core.List<LogLine> get logs => $_getList(5);

  /// Resource usage during this call. Populated when capture_metrics=true.
  @$pb.TagNumber(7)
  Metrics get metrics => $_getN(6);
  @$pb.TagNumber(7)
  set metrics(Metrics v) {
    setField(7, v);
  }

  @$pb.TagNumber(7)
  $core.bool hasMetrics() => $_has(6);
  @$pb.TagNumber(7)
  void clearMetrics() => clearField(7);
  @$pb.TagNumber(7)
  Metrics ensureMetrics() => $_ensure(6);
}

enum ExecuteEvent_Event { started, log, progress, partial, final_5, notSet }

class ExecuteEvent extends $pb.GeneratedMessage {
  factory ExecuteEvent({
    NodeStarted? started,
    LogLine? log,
    Progress? progress,
    PartialResult? partial,
    ExecuteResponse? final_5,
  }) {
    final $result = create();
    if (started != null) {
      $result.started = started;
    }
    if (log != null) {
      $result.log = log;
    }
    if (progress != null) {
      $result.progress = progress;
    }
    if (partial != null) {
      $result.partial = partial;
    }
    if (final_5 != null) {
      $result.final_5 = final_5;
    }
    return $result;
  }
  ExecuteEvent._() : super();
  factory ExecuteEvent.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory ExecuteEvent.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static const $core.Map<$core.int, ExecuteEvent_Event>
      _ExecuteEvent_EventByTag = {
    1: ExecuteEvent_Event.started,
    2: ExecuteEvent_Event.log,
    3: ExecuteEvent_Event.progress,
    4: ExecuteEvent_Event.partial,
    5: ExecuteEvent_Event.final_5,
    0: ExecuteEvent_Event.notSet
  };
  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ExecuteEvent',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..oo(0, [1, 2, 3, 4, 5])
    ..aOM<NodeStarted>(1, _omitFieldNames ? '' : 'started',
        subBuilder: NodeStarted.create)
    ..aOM<LogLine>(2, _omitFieldNames ? '' : 'log', subBuilder: LogLine.create)
    ..aOM<Progress>(3, _omitFieldNames ? '' : 'progress',
        subBuilder: Progress.create)
    ..aOM<PartialResult>(4, _omitFieldNames ? '' : 'partial',
        subBuilder: PartialResult.create)
    ..aOM<ExecuteResponse>(5, _omitFieldNames ? '' : 'final',
        subBuilder: ExecuteResponse.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  ExecuteEvent clone() => ExecuteEvent()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  ExecuteEvent copyWith(void Function(ExecuteEvent) updates) =>
      super.copyWith((message) => updates(message as ExecuteEvent))
          as ExecuteEvent;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static ExecuteEvent create() => ExecuteEvent._();
  ExecuteEvent createEmptyInstance() => create();
  static $pb.PbList<ExecuteEvent> createRepeated() =>
      $pb.PbList<ExecuteEvent>();
  @$core.pragma('dart2js:noInline')
  static ExecuteEvent getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<ExecuteEvent>(create);
  static ExecuteEvent? _defaultInstance;

  ExecuteEvent_Event whichEvent() => _ExecuteEvent_EventByTag[$_whichOneof(0)]!;
  void clearEvent() => clearField($_whichOneof(0));

  @$pb.TagNumber(1)
  NodeStarted get started => $_getN(0);
  @$pb.TagNumber(1)
  set started(NodeStarted v) {
    setField(1, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasStarted() => $_has(0);
  @$pb.TagNumber(1)
  void clearStarted() => clearField(1);
  @$pb.TagNumber(1)
  NodeStarted ensureStarted() => $_ensure(0);

  @$pb.TagNumber(2)
  LogLine get log => $_getN(1);
  @$pb.TagNumber(2)
  set log(LogLine v) {
    setField(2, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasLog() => $_has(1);
  @$pb.TagNumber(2)
  void clearLog() => clearField(2);
  @$pb.TagNumber(2)
  LogLine ensureLog() => $_ensure(1);

  @$pb.TagNumber(3)
  Progress get progress => $_getN(2);
  @$pb.TagNumber(3)
  set progress(Progress v) {
    setField(3, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasProgress() => $_has(2);
  @$pb.TagNumber(3)
  void clearProgress() => clearField(3);
  @$pb.TagNumber(3)
  Progress ensureProgress() => $_ensure(2);

  @$pb.TagNumber(4)
  PartialResult get partial => $_getN(3);
  @$pb.TagNumber(4)
  set partial(PartialResult v) {
    setField(4, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasPartial() => $_has(3);
  @$pb.TagNumber(4)
  void clearPartial() => clearField(4);
  @$pb.TagNumber(4)
  PartialResult ensurePartial() => $_ensure(3);

  @$pb.TagNumber(5)
  ExecuteResponse get final_5 => $_getN(4);
  @$pb.TagNumber(5)
  set final_5(ExecuteResponse v) {
    setField(5, v);
  }

  @$pb.TagNumber(5)
  $core.bool hasFinal_5() => $_has(4);
  @$pb.TagNumber(5)
  void clearFinal_5() => clearField(5);
  @$pb.TagNumber(5)
  ExecuteResponse ensureFinal_5() => $_ensure(4);
}

class NodeStarted extends $pb.GeneratedMessage {
  factory NodeStarted({
    $1.Timestamp? at,
  }) {
    final $result = create();
    if (at != null) {
      $result.at = at;
    }
    return $result;
  }
  NodeStarted._() : super();
  factory NodeStarted.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory NodeStarted.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'NodeStarted',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOM<$1.Timestamp>(1, _omitFieldNames ? '' : 'at',
        subBuilder: $1.Timestamp.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  NodeStarted clone() => NodeStarted()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  NodeStarted copyWith(void Function(NodeStarted) updates) =>
      super.copyWith((message) => updates(message as NodeStarted))
          as NodeStarted;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static NodeStarted create() => NodeStarted._();
  NodeStarted createEmptyInstance() => create();
  static $pb.PbList<NodeStarted> createRepeated() => $pb.PbList<NodeStarted>();
  @$core.pragma('dart2js:noInline')
  static NodeStarted getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<NodeStarted>(create);
  static NodeStarted? _defaultInstance;

  @$pb.TagNumber(1)
  $1.Timestamp get at => $_getN(0);
  @$pb.TagNumber(1)
  set at($1.Timestamp v) {
    setField(1, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasAt() => $_has(0);
  @$pb.TagNumber(1)
  void clearAt() => clearField(1);
  @$pb.TagNumber(1)
  $1.Timestamp ensureAt() => $_ensure(0);
}

class Progress extends $pb.GeneratedMessage {
  factory Progress({
    $core.double? percent,
    $core.String? phase,
  }) {
    final $result = create();
    if (percent != null) {
      $result.percent = percent;
    }
    if (phase != null) {
      $result.phase = phase;
    }
    return $result;
  }
  Progress._() : super();
  factory Progress.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory Progress.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Progress',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..a<$core.double>(1, _omitFieldNames ? '' : 'percent', $pb.PbFieldType.OD)
    ..aOS(2, _omitFieldNames ? '' : 'phase')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  Progress clone() => Progress()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  Progress copyWith(void Function(Progress) updates) =>
      super.copyWith((message) => updates(message as Progress)) as Progress;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Progress create() => Progress._();
  Progress createEmptyInstance() => create();
  static $pb.PbList<Progress> createRepeated() => $pb.PbList<Progress>();
  @$core.pragma('dart2js:noInline')
  static Progress getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Progress>(create);
  static Progress? _defaultInstance;

  @$pb.TagNumber(1)
  $core.double get percent => $_getN(0);
  @$pb.TagNumber(1)
  set percent($core.double v) {
    $_setDouble(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasPercent() => $_has(0);
  @$pb.TagNumber(1)
  void clearPercent() => clearField(1);

  @$pb.TagNumber(2)
  $core.String get phase => $_getSZ(1);
  @$pb.TagNumber(2)
  set phase($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasPhase() => $_has(1);
  @$pb.TagNumber(2)
  void clearPhase() => clearField(2);
}

class PartialResult extends $pb.GeneratedMessage {
  factory PartialResult({
    $core.List<$core.int>? snapshotJson,
  }) {
    final $result = create();
    if (snapshotJson != null) {
      $result.snapshotJson = snapshotJson;
    }
    return $result;
  }
  PartialResult._() : super();
  factory PartialResult.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory PartialResult.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'PartialResult',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..a<$core.List<$core.int>>(
        1, _omitFieldNames ? '' : 'snapshotJson', $pb.PbFieldType.OY)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  PartialResult clone() => PartialResult()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  PartialResult copyWith(void Function(PartialResult) updates) =>
      super.copyWith((message) => updates(message as PartialResult))
          as PartialResult;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static PartialResult create() => PartialResult._();
  PartialResult createEmptyInstance() => create();
  static $pb.PbList<PartialResult> createRepeated() =>
      $pb.PbList<PartialResult>();
  @$core.pragma('dart2js:noInline')
  static PartialResult getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<PartialResult>(create);
  static PartialResult? _defaultInstance;

  @$pb.TagNumber(1)
  $core.List<$core.int> get snapshotJson => $_getN(0);
  @$pb.TagNumber(1)
  set snapshotJson($core.List<$core.int> v) {
    $_setBytes(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasSnapshotJson() => $_has(0);
  @$pb.TagNumber(1)
  void clearSnapshotJson() => clearField(1);
}

class LogLine extends $pb.GeneratedMessage {
  factory LogLine({
    $1.Timestamp? timestamp,
    $core.String? level,
    $core.String? message,
    $core.Map<$core.String, $core.String>? attributes,
  }) {
    final $result = create();
    if (timestamp != null) {
      $result.timestamp = timestamp;
    }
    if (level != null) {
      $result.level = level;
    }
    if (message != null) {
      $result.message = message;
    }
    if (attributes != null) {
      $result.attributes.addAll(attributes);
    }
    return $result;
  }
  LogLine._() : super();
  factory LogLine.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory LogLine.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'LogLine',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOM<$1.Timestamp>(1, _omitFieldNames ? '' : 'timestamp',
        subBuilder: $1.Timestamp.create)
    ..aOS(2, _omitFieldNames ? '' : 'level')
    ..aOS(3, _omitFieldNames ? '' : 'message')
    ..m<$core.String, $core.String>(4, _omitFieldNames ? '' : 'attributes',
        entryClassName: 'LogLine.AttributesEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('blok.runtime.v1'))
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  LogLine clone() => LogLine()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  LogLine copyWith(void Function(LogLine) updates) =>
      super.copyWith((message) => updates(message as LogLine)) as LogLine;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static LogLine create() => LogLine._();
  LogLine createEmptyInstance() => create();
  static $pb.PbList<LogLine> createRepeated() => $pb.PbList<LogLine>();
  @$core.pragma('dart2js:noInline')
  static LogLine getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<LogLine>(create);
  static LogLine? _defaultInstance;

  @$pb.TagNumber(1)
  $1.Timestamp get timestamp => $_getN(0);
  @$pb.TagNumber(1)
  set timestamp($1.Timestamp v) {
    setField(1, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasTimestamp() => $_has(0);
  @$pb.TagNumber(1)
  void clearTimestamp() => clearField(1);
  @$pb.TagNumber(1)
  $1.Timestamp ensureTimestamp() => $_ensure(0);

  @$pb.TagNumber(2)
  $core.String get level => $_getSZ(1);
  @$pb.TagNumber(2)
  set level($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasLevel() => $_has(1);
  @$pb.TagNumber(2)
  void clearLevel() => clearField(2);

  @$pb.TagNumber(3)
  $core.String get message => $_getSZ(2);
  @$pb.TagNumber(3)
  set message($core.String v) {
    $_setString(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasMessage() => $_has(2);
  @$pb.TagNumber(3)
  void clearMessage() => clearField(3);

  @$pb.TagNumber(4)
  $core.Map<$core.String, $core.String> get attributes => $_getMap(3);
}

class NodeError extends $pb.GeneratedMessage {
  factory NodeError({
    $core.String? code,
    ErrorCategory? category,
    ErrorSeverity? severity,
    $core.String? node,
    $core.String? sdk,
    $core.String? sdkVersion,
    $core.String? runtimeKind,
    $1.Timestamp? at,
    $core.String? message,
    $core.String? description,
    $core.String? remediation,
    $core.String? docUrl,
    $core.Iterable<NodeError>? causes,
    $core.String? stack,
    $core.List<$core.int>? contextSnapshotJson,
    $core.int? httpStatus,
    $core.bool? retryable,
    $fixnum.Int64? retryAfterMs,
    $core.List<$core.int>? detailsJson,
  }) {
    final $result = create();
    if (code != null) {
      $result.code = code;
    }
    if (category != null) {
      $result.category = category;
    }
    if (severity != null) {
      $result.severity = severity;
    }
    if (node != null) {
      $result.node = node;
    }
    if (sdk != null) {
      $result.sdk = sdk;
    }
    if (sdkVersion != null) {
      $result.sdkVersion = sdkVersion;
    }
    if (runtimeKind != null) {
      $result.runtimeKind = runtimeKind;
    }
    if (at != null) {
      $result.at = at;
    }
    if (message != null) {
      $result.message = message;
    }
    if (description != null) {
      $result.description = description;
    }
    if (remediation != null) {
      $result.remediation = remediation;
    }
    if (docUrl != null) {
      $result.docUrl = docUrl;
    }
    if (causes != null) {
      $result.causes.addAll(causes);
    }
    if (stack != null) {
      $result.stack = stack;
    }
    if (contextSnapshotJson != null) {
      $result.contextSnapshotJson = contextSnapshotJson;
    }
    if (httpStatus != null) {
      $result.httpStatus = httpStatus;
    }
    if (retryable != null) {
      $result.retryable = retryable;
    }
    if (retryAfterMs != null) {
      $result.retryAfterMs = retryAfterMs;
    }
    if (detailsJson != null) {
      $result.detailsJson = detailsJson;
    }
    return $result;
  }
  NodeError._() : super();
  factory NodeError.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory NodeError.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'NodeError',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'code')
    ..e<ErrorCategory>(2, _omitFieldNames ? '' : 'category', $pb.PbFieldType.OE,
        defaultOrMaker: ErrorCategory.CATEGORY_UNSPECIFIED,
        valueOf: ErrorCategory.valueOf,
        enumValues: ErrorCategory.values)
    ..e<ErrorSeverity>(3, _omitFieldNames ? '' : 'severity', $pb.PbFieldType.OE,
        defaultOrMaker: ErrorSeverity.SEVERITY_UNSPECIFIED,
        valueOf: ErrorSeverity.valueOf,
        enumValues: ErrorSeverity.values)
    ..aOS(4, _omitFieldNames ? '' : 'node')
    ..aOS(5, _omitFieldNames ? '' : 'sdk')
    ..aOS(6, _omitFieldNames ? '' : 'sdkVersion')
    ..aOS(7, _omitFieldNames ? '' : 'runtimeKind')
    ..aOM<$1.Timestamp>(8, _omitFieldNames ? '' : 'at',
        subBuilder: $1.Timestamp.create)
    ..aOS(9, _omitFieldNames ? '' : 'message')
    ..aOS(10, _omitFieldNames ? '' : 'description')
    ..aOS(11, _omitFieldNames ? '' : 'remediation')
    ..aOS(12, _omitFieldNames ? '' : 'docUrl')
    ..pc<NodeError>(13, _omitFieldNames ? '' : 'causes', $pb.PbFieldType.PM,
        subBuilder: NodeError.create)
    ..aOS(14, _omitFieldNames ? '' : 'stack')
    ..a<$core.List<$core.int>>(
        15, _omitFieldNames ? '' : 'contextSnapshotJson', $pb.PbFieldType.OY)
    ..a<$core.int>(16, _omitFieldNames ? '' : 'httpStatus', $pb.PbFieldType.O3)
    ..aOB(17, _omitFieldNames ? '' : 'retryable')
    ..aInt64(18, _omitFieldNames ? '' : 'retryAfterMs')
    ..a<$core.List<$core.int>>(
        19, _omitFieldNames ? '' : 'detailsJson', $pb.PbFieldType.OY)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  NodeError clone() => NodeError()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  NodeError copyWith(void Function(NodeError) updates) =>
      super.copyWith((message) => updates(message as NodeError)) as NodeError;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static NodeError create() => NodeError._();
  NodeError createEmptyInstance() => create();
  static $pb.PbList<NodeError> createRepeated() => $pb.PbList<NodeError>();
  @$core.pragma('dart2js:noInline')
  static NodeError getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<NodeError>(create);
  static NodeError? _defaultInstance;

  /// === Identity ===
  @$pb.TagNumber(1)
  $core.String get code => $_getSZ(0);
  @$pb.TagNumber(1)
  set code($core.String v) {
    $_setString(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasCode() => $_has(0);
  @$pb.TagNumber(1)
  void clearCode() => clearField(1);

  @$pb.TagNumber(2)
  ErrorCategory get category => $_getN(1);
  @$pb.TagNumber(2)
  set category(ErrorCategory v) {
    setField(2, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasCategory() => $_has(1);
  @$pb.TagNumber(2)
  void clearCategory() => clearField(2);

  @$pb.TagNumber(3)
  ErrorSeverity get severity => $_getN(2);
  @$pb.TagNumber(3)
  set severity(ErrorSeverity v) {
    setField(3, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasSeverity() => $_has(2);
  @$pb.TagNumber(3)
  void clearSeverity() => clearField(3);

  /// === Origin (auto-filled by SDK) ===
  @$pb.TagNumber(4)
  $core.String get node => $_getSZ(3);
  @$pb.TagNumber(4)
  set node($core.String v) {
    $_setString(3, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasNode() => $_has(3);
  @$pb.TagNumber(4)
  void clearNode() => clearField(4);

  @$pb.TagNumber(5)
  $core.String get sdk => $_getSZ(4);
  @$pb.TagNumber(5)
  set sdk($core.String v) {
    $_setString(4, v);
  }

  @$pb.TagNumber(5)
  $core.bool hasSdk() => $_has(4);
  @$pb.TagNumber(5)
  void clearSdk() => clearField(5);

  @$pb.TagNumber(6)
  $core.String get sdkVersion => $_getSZ(5);
  @$pb.TagNumber(6)
  set sdkVersion($core.String v) {
    $_setString(5, v);
  }

  @$pb.TagNumber(6)
  $core.bool hasSdkVersion() => $_has(5);
  @$pb.TagNumber(6)
  void clearSdkVersion() => clearField(6);

  @$pb.TagNumber(7)
  $core.String get runtimeKind => $_getSZ(6);
  @$pb.TagNumber(7)
  set runtimeKind($core.String v) {
    $_setString(6, v);
  }

  @$pb.TagNumber(7)
  $core.bool hasRuntimeKind() => $_has(6);
  @$pb.TagNumber(7)
  void clearRuntimeKind() => clearField(7);

  @$pb.TagNumber(8)
  $1.Timestamp get at => $_getN(7);
  @$pb.TagNumber(8)
  set at($1.Timestamp v) {
    setField(8, v);
  }

  @$pb.TagNumber(8)
  $core.bool hasAt() => $_has(7);
  @$pb.TagNumber(8)
  void clearAt() => clearField(8);
  @$pb.TagNumber(8)
  $1.Timestamp ensureAt() => $_ensure(7);

  /// === Human-readable ===
  @$pb.TagNumber(9)
  $core.String get message => $_getSZ(8);
  @$pb.TagNumber(9)
  set message($core.String v) {
    $_setString(8, v);
  }

  @$pb.TagNumber(9)
  $core.bool hasMessage() => $_has(8);
  @$pb.TagNumber(9)
  void clearMessage() => clearField(9);

  @$pb.TagNumber(10)
  $core.String get description => $_getSZ(9);
  @$pb.TagNumber(10)
  set description($core.String v) {
    $_setString(9, v);
  }

  @$pb.TagNumber(10)
  $core.bool hasDescription() => $_has(9);
  @$pb.TagNumber(10)
  void clearDescription() => clearField(10);

  @$pb.TagNumber(11)
  $core.String get remediation => $_getSZ(10);
  @$pb.TagNumber(11)
  set remediation($core.String v) {
    $_setString(10, v);
  }

  @$pb.TagNumber(11)
  $core.bool hasRemediation() => $_has(10);
  @$pb.TagNumber(11)
  void clearRemediation() => clearField(11);

  @$pb.TagNumber(12)
  $core.String get docUrl => $_getSZ(11);
  @$pb.TagNumber(12)
  set docUrl($core.String v) {
    $_setString(11, v);
  }

  @$pb.TagNumber(12)
  $core.bool hasDocUrl() => $_has(11);
  @$pb.TagNumber(12)
  void clearDocUrl() => clearField(12);

  /// === Causality ===
  @$pb.TagNumber(13)
  $core.List<NodeError> get causes => $_getList(12);

  @$pb.TagNumber(14)
  $core.String get stack => $_getSZ(13);
  @$pb.TagNumber(14)
  set stack($core.String v) {
    $_setString(13, v);
  }

  @$pb.TagNumber(14)
  $core.bool hasStack() => $_has(13);
  @$pb.TagNumber(14)
  void clearStack() => clearField(14);

  @$pb.TagNumber(15)
  $core.List<$core.int> get contextSnapshotJson => $_getN(14);
  @$pb.TagNumber(15)
  set contextSnapshotJson($core.List<$core.int> v) {
    $_setBytes(14, v);
  }

  @$pb.TagNumber(15)
  $core.bool hasContextSnapshotJson() => $_has(14);
  @$pb.TagNumber(15)
  void clearContextSnapshotJson() => clearField(15);

  /// === Compatibility / retry hints ===
  @$pb.TagNumber(16)
  $core.int get httpStatus => $_getIZ(15);
  @$pb.TagNumber(16)
  set httpStatus($core.int v) {
    $_setSignedInt32(15, v);
  }

  @$pb.TagNumber(16)
  $core.bool hasHttpStatus() => $_has(15);
  @$pb.TagNumber(16)
  void clearHttpStatus() => clearField(16);

  @$pb.TagNumber(17)
  $core.bool get retryable => $_getBF(16);
  @$pb.TagNumber(17)
  set retryable($core.bool v) {
    $_setBool(16, v);
  }

  @$pb.TagNumber(17)
  $core.bool hasRetryable() => $_has(16);
  @$pb.TagNumber(17)
  void clearRetryable() => clearField(17);

  @$pb.TagNumber(18)
  $fixnum.Int64 get retryAfterMs => $_getI64(17);
  @$pb.TagNumber(18)
  set retryAfterMs($fixnum.Int64 v) {
    $_setInt64(17, v);
  }

  @$pb.TagNumber(18)
  $core.bool hasRetryAfterMs() => $_has(17);
  @$pb.TagNumber(18)
  void clearRetryAfterMs() => clearField(18);

  /// === Category-specific structured details ===
  /// Bytes-encoded JSON. Surfaces to GlobalError.json on the runner side.
  @$pb.TagNumber(19)
  $core.List<$core.int> get detailsJson => $_getN(18);
  @$pb.TagNumber(19)
  set detailsJson($core.List<$core.int> v) {
    $_setBytes(18, v);
  }

  @$pb.TagNumber(19)
  $core.bool hasDetailsJson() => $_has(18);
  @$pb.TagNumber(19)
  void clearDetailsJson() => clearField(19);
}

class ListNodesRequest extends $pb.GeneratedMessage {
  factory ListNodesRequest() => create();
  ListNodesRequest._() : super();
  factory ListNodesRequest.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory ListNodesRequest.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ListNodesRequest',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  ListNodesRequest clone() => ListNodesRequest()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  ListNodesRequest copyWith(void Function(ListNodesRequest) updates) =>
      super.copyWith((message) => updates(message as ListNodesRequest))
          as ListNodesRequest;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static ListNodesRequest create() => ListNodesRequest._();
  ListNodesRequest createEmptyInstance() => create();
  static $pb.PbList<ListNodesRequest> createRepeated() =>
      $pb.PbList<ListNodesRequest>();
  @$core.pragma('dart2js:noInline')
  static ListNodesRequest getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<ListNodesRequest>(create);
  static ListNodesRequest? _defaultInstance;
}

class ListNodesResponse extends $pb.GeneratedMessage {
  factory ListNodesResponse({
    $core.Iterable<NodeDescriptor>? nodes,
    $core.String? sdkName,
    $core.String? sdkVersion,
    $core.String? protoVersion,
    $core.Iterable<$core.String>? capabilities,
  }) {
    final $result = create();
    if (nodes != null) {
      $result.nodes.addAll(nodes);
    }
    if (sdkName != null) {
      $result.sdkName = sdkName;
    }
    if (sdkVersion != null) {
      $result.sdkVersion = sdkVersion;
    }
    if (protoVersion != null) {
      $result.protoVersion = protoVersion;
    }
    if (capabilities != null) {
      $result.capabilities.addAll(capabilities);
    }
    return $result;
  }
  ListNodesResponse._() : super();
  factory ListNodesResponse.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory ListNodesResponse.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ListNodesResponse',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..pc<NodeDescriptor>(1, _omitFieldNames ? '' : 'nodes', $pb.PbFieldType.PM,
        subBuilder: NodeDescriptor.create)
    ..aOS(2, _omitFieldNames ? '' : 'sdkName')
    ..aOS(3, _omitFieldNames ? '' : 'sdkVersion')
    ..aOS(4, _omitFieldNames ? '' : 'protoVersion')
    ..pPS(5, _omitFieldNames ? '' : 'capabilities')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  ListNodesResponse clone() => ListNodesResponse()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  ListNodesResponse copyWith(void Function(ListNodesResponse) updates) =>
      super.copyWith((message) => updates(message as ListNodesResponse))
          as ListNodesResponse;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static ListNodesResponse create() => ListNodesResponse._();
  ListNodesResponse createEmptyInstance() => create();
  static $pb.PbList<ListNodesResponse> createRepeated() =>
      $pb.PbList<ListNodesResponse>();
  @$core.pragma('dart2js:noInline')
  static ListNodesResponse getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<ListNodesResponse>(create);
  static ListNodesResponse? _defaultInstance;

  @$pb.TagNumber(1)
  $core.List<NodeDescriptor> get nodes => $_getList(0);

  @$pb.TagNumber(2)
  $core.String get sdkName => $_getSZ(1);
  @$pb.TagNumber(2)
  set sdkName($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasSdkName() => $_has(1);
  @$pb.TagNumber(2)
  void clearSdkName() => clearField(2);

  @$pb.TagNumber(3)
  $core.String get sdkVersion => $_getSZ(2);
  @$pb.TagNumber(3)
  set sdkVersion($core.String v) {
    $_setString(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasSdkVersion() => $_has(2);
  @$pb.TagNumber(3)
  void clearSdkVersion() => clearField(3);

  @$pb.TagNumber(4)
  $core.String get protoVersion => $_getSZ(3);
  @$pb.TagNumber(4)
  set protoVersion($core.String v) {
    $_setString(3, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasProtoVersion() => $_has(3);
  @$pb.TagNumber(4)
  void clearProtoVersion() => clearField(4);

  ///  Optional runtime capabilities this SDK advertises (ADR 0014). Additive:
  ///  an SDK that leaves it empty is assumed to support only the base contract,
  ///  and the runner degrades accordingly — never a hard failure.
  ///
  ///  Known values:
  ///    "blob-v1" — the SDK resolves a claim-check sentinel
  ///                {"$blokBlob":{"id","bytes","codec"}} appearing in place of
  ///                `ExecuteRequest.inputs` by reading `<BLOK_BLOB_DIR>/<id>`.
  ///                Advertise it ONLY when BLOK_BLOB_DIR is set and readable —
  ///                the runner sends refs solely to runtimes that claim it.
  @$pb.TagNumber(5)
  $core.List<$core.String> get capabilities => $_getList(4);
}

class NodeDescriptor extends $pb.GeneratedMessage {
  factory NodeDescriptor({
    $core.String? name,
    $core.String? description,
    $core.List<$core.int>? inputSchemaJson,
    $core.List<$core.int>? outputSchemaJson,
    $core.Iterable<$core.String>? tags,
    $core.List<$core.int>? capabilityManifestJson,
  }) {
    final $result = create();
    if (name != null) {
      $result.name = name;
    }
    if (description != null) {
      $result.description = description;
    }
    if (inputSchemaJson != null) {
      $result.inputSchemaJson = inputSchemaJson;
    }
    if (outputSchemaJson != null) {
      $result.outputSchemaJson = outputSchemaJson;
    }
    if (tags != null) {
      $result.tags.addAll(tags);
    }
    if (capabilityManifestJson != null) {
      $result.capabilityManifestJson = capabilityManifestJson;
    }
    return $result;
  }
  NodeDescriptor._() : super();
  factory NodeDescriptor.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory NodeDescriptor.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'NodeDescriptor',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'name')
    ..aOS(2, _omitFieldNames ? '' : 'description')
    ..a<$core.List<$core.int>>(
        3, _omitFieldNames ? '' : 'inputSchemaJson', $pb.PbFieldType.OY)
    ..a<$core.List<$core.int>>(
        4, _omitFieldNames ? '' : 'outputSchemaJson', $pb.PbFieldType.OY)
    ..pPS(5, _omitFieldNames ? '' : 'tags')
    ..a<$core.List<$core.int>>(
        6, _omitFieldNames ? '' : 'capabilityManifestJson', $pb.PbFieldType.OY)
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  NodeDescriptor clone() => NodeDescriptor()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  NodeDescriptor copyWith(void Function(NodeDescriptor) updates) =>
      super.copyWith((message) => updates(message as NodeDescriptor))
          as NodeDescriptor;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static NodeDescriptor create() => NodeDescriptor._();
  NodeDescriptor createEmptyInstance() => create();
  static $pb.PbList<NodeDescriptor> createRepeated() =>
      $pb.PbList<NodeDescriptor>();
  @$core.pragma('dart2js:noInline')
  static NodeDescriptor getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<NodeDescriptor>(create);
  static NodeDescriptor? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get name => $_getSZ(0);
  @$pb.TagNumber(1)
  set name($core.String v) {
    $_setString(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasName() => $_has(0);
  @$pb.TagNumber(1)
  void clearName() => clearField(1);

  @$pb.TagNumber(2)
  $core.String get description => $_getSZ(1);
  @$pb.TagNumber(2)
  set description($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasDescription() => $_has(1);
  @$pb.TagNumber(2)
  void clearDescription() => clearField(2);

  @$pb.TagNumber(3)
  $core.List<$core.int> get inputSchemaJson => $_getN(2);
  @$pb.TagNumber(3)
  set inputSchemaJson($core.List<$core.int> v) {
    $_setBytes(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasInputSchemaJson() => $_has(2);
  @$pb.TagNumber(3)
  void clearInputSchemaJson() => clearField(3);

  @$pb.TagNumber(4)
  $core.List<$core.int> get outputSchemaJson => $_getN(3);
  @$pb.TagNumber(4)
  set outputSchemaJson($core.List<$core.int> v) {
    $_setBytes(3, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasOutputSchemaJson() => $_has(3);
  @$pb.TagNumber(4)
  void clearOutputSchemaJson() => clearField(4);

  @$pb.TagNumber(5)
  $core.List<$core.String> get tags => $_getList(4);

  /// CapabilityManifestV1 JSON (ADR 0003). Additive and optional: empty means
  /// legacy/unclassified, which ordinary workflows may still execute but agent
  /// policy MUST treat as ineligible rather than silently safe.
  @$pb.TagNumber(6)
  $core.List<$core.int> get capabilityManifestJson => $_getN(5);
  @$pb.TagNumber(6)
  set capabilityManifestJson($core.List<$core.int> v) {
    $_setBytes(5, v);
  }

  @$pb.TagNumber(6)
  $core.bool hasCapabilityManifestJson() => $_has(5);
  @$pb.TagNumber(6)
  void clearCapabilityManifestJson() => clearField(6);
}

class HealthRequest extends $pb.GeneratedMessage {
  factory HealthRequest({
    $core.String? service,
  }) {
    final $result = create();
    if (service != null) {
      $result.service = service;
    }
    return $result;
  }
  HealthRequest._() : super();
  factory HealthRequest.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory HealthRequest.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'HealthRequest',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'service')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  HealthRequest clone() => HealthRequest()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  HealthRequest copyWith(void Function(HealthRequest) updates) =>
      super.copyWith((message) => updates(message as HealthRequest))
          as HealthRequest;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static HealthRequest create() => HealthRequest._();
  HealthRequest createEmptyInstance() => create();
  static $pb.PbList<HealthRequest> createRepeated() =>
      $pb.PbList<HealthRequest>();
  @$core.pragma('dart2js:noInline')
  static HealthRequest getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<HealthRequest>(create);
  static HealthRequest? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get service => $_getSZ(0);
  @$pb.TagNumber(1)
  set service($core.String v) {
    $_setString(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasService() => $_has(0);
  @$pb.TagNumber(1)
  void clearService() => clearField(1);
}

class HealthResponse extends $pb.GeneratedMessage {
  factory HealthResponse({
    HealthResponse_Status? status,
    $core.String? sdkVersion,
    $core.Iterable<$core.String>? registeredNodes,
  }) {
    final $result = create();
    if (status != null) {
      $result.status = status;
    }
    if (sdkVersion != null) {
      $result.sdkVersion = sdkVersion;
    }
    if (registeredNodes != null) {
      $result.registeredNodes.addAll(registeredNodes);
    }
    return $result;
  }
  HealthResponse._() : super();
  factory HealthResponse.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory HealthResponse.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'HealthResponse',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..e<HealthResponse_Status>(
        1, _omitFieldNames ? '' : 'status', $pb.PbFieldType.OE,
        defaultOrMaker: HealthResponse_Status.UNKNOWN,
        valueOf: HealthResponse_Status.valueOf,
        enumValues: HealthResponse_Status.values)
    ..aOS(2, _omitFieldNames ? '' : 'sdkVersion')
    ..pPS(3, _omitFieldNames ? '' : 'registeredNodes')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  HealthResponse clone() => HealthResponse()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  HealthResponse copyWith(void Function(HealthResponse) updates) =>
      super.copyWith((message) => updates(message as HealthResponse))
          as HealthResponse;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static HealthResponse create() => HealthResponse._();
  HealthResponse createEmptyInstance() => create();
  static $pb.PbList<HealthResponse> createRepeated() =>
      $pb.PbList<HealthResponse>();
  @$core.pragma('dart2js:noInline')
  static HealthResponse getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<HealthResponse>(create);
  static HealthResponse? _defaultInstance;

  @$pb.TagNumber(1)
  HealthResponse_Status get status => $_getN(0);
  @$pb.TagNumber(1)
  set status(HealthResponse_Status v) {
    setField(1, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasStatus() => $_has(0);
  @$pb.TagNumber(1)
  void clearStatus() => clearField(1);

  @$pb.TagNumber(2)
  $core.String get sdkVersion => $_getSZ(1);
  @$pb.TagNumber(2)
  set sdkVersion($core.String v) {
    $_setString(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasSdkVersion() => $_has(1);
  @$pb.TagNumber(2)
  void clearSdkVersion() => clearField(2);

  @$pb.TagNumber(3)
  $core.List<$core.String> get registeredNodes => $_getList(2);
}

class Metrics extends $pb.GeneratedMessage {
  factory Metrics({
    $core.double? durationMs,
    $core.double? cpuMs,
    $fixnum.Int64? memoryBytes,
    $fixnum.Int64? requestBytes,
    $fixnum.Int64? responseBytes,
  }) {
    final $result = create();
    if (durationMs != null) {
      $result.durationMs = durationMs;
    }
    if (cpuMs != null) {
      $result.cpuMs = cpuMs;
    }
    if (memoryBytes != null) {
      $result.memoryBytes = memoryBytes;
    }
    if (requestBytes != null) {
      $result.requestBytes = requestBytes;
    }
    if (responseBytes != null) {
      $result.responseBytes = responseBytes;
    }
    return $result;
  }
  Metrics._() : super();
  factory Metrics.fromBuffer($core.List<$core.int> i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(i, r);
  factory Metrics.fromJson($core.String i,
          [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Metrics',
      package:
          const $pb.PackageName(_omitMessageNames ? '' : 'blok.runtime.v1'),
      createEmptyInstance: create)
    ..a<$core.double>(
        1, _omitFieldNames ? '' : 'durationMs', $pb.PbFieldType.OD)
    ..a<$core.double>(2, _omitFieldNames ? '' : 'cpuMs', $pb.PbFieldType.OD)
    ..aInt64(3, _omitFieldNames ? '' : 'memoryBytes')
    ..aInt64(4, _omitFieldNames ? '' : 'requestBytes')
    ..aInt64(5, _omitFieldNames ? '' : 'responseBytes')
    ..hasRequiredFields = false;

  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
      'Will be removed in next major version')
  Metrics clone() => Metrics()..mergeFromMessage(this);
  @$core.Deprecated('Using this can add significant overhead to your binary. '
      'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
      'Will be removed in next major version')
  Metrics copyWith(void Function(Metrics) updates) =>
      super.copyWith((message) => updates(message as Metrics)) as Metrics;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Metrics create() => Metrics._();
  Metrics createEmptyInstance() => create();
  static $pb.PbList<Metrics> createRepeated() => $pb.PbList<Metrics>();
  @$core.pragma('dart2js:noInline')
  static Metrics getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Metrics>(create);
  static Metrics? _defaultInstance;

  @$pb.TagNumber(1)
  $core.double get durationMs => $_getN(0);
  @$pb.TagNumber(1)
  set durationMs($core.double v) {
    $_setDouble(0, v);
  }

  @$pb.TagNumber(1)
  $core.bool hasDurationMs() => $_has(0);
  @$pb.TagNumber(1)
  void clearDurationMs() => clearField(1);

  @$pb.TagNumber(2)
  $core.double get cpuMs => $_getN(1);
  @$pb.TagNumber(2)
  set cpuMs($core.double v) {
    $_setDouble(1, v);
  }

  @$pb.TagNumber(2)
  $core.bool hasCpuMs() => $_has(1);
  @$pb.TagNumber(2)
  void clearCpuMs() => clearField(2);

  @$pb.TagNumber(3)
  $fixnum.Int64 get memoryBytes => $_getI64(2);
  @$pb.TagNumber(3)
  set memoryBytes($fixnum.Int64 v) {
    $_setInt64(2, v);
  }

  @$pb.TagNumber(3)
  $core.bool hasMemoryBytes() => $_has(2);
  @$pb.TagNumber(3)
  void clearMemoryBytes() => clearField(3);

  @$pb.TagNumber(4)
  $fixnum.Int64 get requestBytes => $_getI64(3);
  @$pb.TagNumber(4)
  set requestBytes($fixnum.Int64 v) {
    $_setInt64(3, v);
  }

  @$pb.TagNumber(4)
  $core.bool hasRequestBytes() => $_has(3);
  @$pb.TagNumber(4)
  void clearRequestBytes() => clearField(4);

  @$pb.TagNumber(5)
  $fixnum.Int64 get responseBytes => $_getI64(4);
  @$pb.TagNumber(5)
  set responseBytes($fixnum.Int64 v) {
    $_setInt64(4, v);
  }

  @$pb.TagNumber(5)
  $core.bool hasResponseBytes() => $_has(4);
  @$pb.TagNumber(5)
  void clearResponseBytes() => clearField(5);
}

const _omitFieldNames = $core.bool.fromEnvironment('protobuf.omit_field_names');
const _omitMessageNames =
    $core.bool.fromEnvironment('protobuf.omit_message_names');
