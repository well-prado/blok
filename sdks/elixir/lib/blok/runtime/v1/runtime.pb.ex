defmodule Blok.Runtime.V1.ErrorCategory do
  @moduledoc false
  use Protobuf, enum: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :CATEGORY_UNSPECIFIED, 0
  field :VALIDATION, 1
  field :CONFIGURATION, 2
  field :DEPENDENCY, 3
  field :TIMEOUT, 4
  field :PERMISSION, 5
  field :RATE_LIMIT, 6
  field :NOT_FOUND, 7
  field :CONFLICT, 8
  field :CANCELLED, 9
  field :INTERNAL, 10
  field :PROTOCOL, 11
  field :DATA, 12
end

defmodule Blok.Runtime.V1.ErrorSeverity do
  @moduledoc false
  use Protobuf, enum: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :SEVERITY_UNSPECIFIED, 0
  field :INFO, 1
  field :WARN, 2
  field :ERROR, 3
  field :FATAL, 4
end

defmodule Blok.Runtime.V1.ExecuteRequest do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :node, 1, type: Blok.Runtime.V1.NodeRef
  field :inputs, 2, type: :bytes
  field :step, 3, type: Blok.Runtime.V1.StepInfo
  field :trigger, 4, type: Blok.Runtime.V1.TriggerInfo
  field :state, 5, type: Blok.Runtime.V1.RuntimeState
  field :workflow, 6, type: Blok.Runtime.V1.WorkflowInfo
  field :options, 7, type: Blok.Runtime.V1.ExecuteOptions
end

defmodule Blok.Runtime.V1.NodeRef do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :name, 1, type: :string
  field :type, 2, type: :string
  field :version, 3, type: :string
end

defmodule Blok.Runtime.V1.StepInfo do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :name, 1, type: :string
  field :index, 2, type: :int32
  field :total, 3, type: :int32
  field :depth, 4, type: :int32
end

defmodule Blok.Runtime.V1.TriggerInfo.HeadersEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.TriggerInfo.ParamsEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.TriggerInfo.QueryEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.TriggerInfo.CookiesEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.TriggerInfo do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :body, 1, type: :bytes
  field :headers, 2, repeated: true, type: Blok.Runtime.V1.TriggerInfo.HeadersEntry, map: true
  field :params, 3, repeated: true, type: Blok.Runtime.V1.TriggerInfo.ParamsEntry, map: true
  field :query, 4, repeated: true, type: Blok.Runtime.V1.TriggerInfo.QueryEntry, map: true
  field :cookies, 5, repeated: true, type: Blok.Runtime.V1.TriggerInfo.CookiesEntry, map: true
  field :method, 6, type: :string
  field :url, 7, type: :string
  field :base_url, 8, type: :string, json_name: "baseUrl"
  field :trigger_kind, 9, type: :string, json_name: "triggerKind"
end

defmodule Blok.Runtime.V1.RuntimeState.EnvEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.RuntimeState do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :previous_output, 1, type: :bytes, json_name: "previousOutput"
  field :vars, 2, type: :bytes
  field :env, 3, repeated: true, type: Blok.Runtime.V1.RuntimeState.EnvEntry, map: true
end

defmodule Blok.Runtime.V1.WorkflowInfo do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :run_id, 1, type: :string, json_name: "runId"
  field :name, 2, type: :string
  field :path, 3, type: :string
  field :version, 4, type: :string
  field :started_at, 5, type: Google.Protobuf.Timestamp, json_name: "startedAt"
end

defmodule Blok.Runtime.V1.ExecuteOptions.HintsEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.ExecuteOptions do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :deadline_ms, 1, type: :int64, json_name: "deadlineMs"
  field :stream_logs, 2, type: :bool, json_name: "streamLogs"
  field :capture_metrics, 3, type: :bool, json_name: "captureMetrics"
  field :hints, 15, repeated: true, type: Blok.Runtime.V1.ExecuteOptions.HintsEntry, map: true
end

defmodule Blok.Runtime.V1.ExecuteResponse do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :success, 1, type: :bool
  field :data, 2, type: :bytes
  field :content_type, 3, type: :string, json_name: "contentType"
  field :error, 4, type: Blok.Runtime.V1.NodeError
  field :vars_delta, 5, type: :bytes, json_name: "varsDelta"
  field :logs, 6, repeated: true, type: Blok.Runtime.V1.LogLine
  field :metrics, 7, type: Blok.Runtime.V1.Metrics
end

defmodule Blok.Runtime.V1.ExecuteEvent do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  oneof :event, 0

  field :started, 1, type: Blok.Runtime.V1.NodeStarted, oneof: 0
  field :log, 2, type: Blok.Runtime.V1.LogLine, oneof: 0
  field :progress, 3, type: Blok.Runtime.V1.Progress, oneof: 0
  field :partial, 4, type: Blok.Runtime.V1.PartialResult, oneof: 0
  field :final, 5, type: Blok.Runtime.V1.ExecuteResponse, oneof: 0
end

defmodule Blok.Runtime.V1.NodeStarted do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :at, 1, type: Google.Protobuf.Timestamp
end

defmodule Blok.Runtime.V1.Progress do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :percent, 1, type: :double
  field :phase, 2, type: :string
end

defmodule Blok.Runtime.V1.PartialResult do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :snapshot_json, 1, type: :bytes, json_name: "snapshotJson"
end

defmodule Blok.Runtime.V1.LogLine.AttributesEntry do
  @moduledoc false
  use Protobuf, map: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :key, 1, type: :string
  field :value, 2, type: :string
end

defmodule Blok.Runtime.V1.LogLine do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :timestamp, 1, type: Google.Protobuf.Timestamp
  field :level, 2, type: :string
  field :message, 3, type: :string
  field :attributes, 4, repeated: true, type: Blok.Runtime.V1.LogLine.AttributesEntry, map: true
end

defmodule Blok.Runtime.V1.NodeError do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :code, 1, type: :string
  field :category, 2, type: Blok.Runtime.V1.ErrorCategory, enum: true
  field :severity, 3, type: Blok.Runtime.V1.ErrorSeverity, enum: true
  field :node, 4, type: :string
  field :sdk, 5, type: :string
  field :sdk_version, 6, type: :string, json_name: "sdkVersion"
  field :runtime_kind, 7, type: :string, json_name: "runtimeKind"
  field :at, 8, type: Google.Protobuf.Timestamp
  field :message, 9, type: :string
  field :description, 10, type: :string
  field :remediation, 11, type: :string
  field :doc_url, 12, type: :string, json_name: "docUrl"
  field :causes, 13, repeated: true, type: Blok.Runtime.V1.NodeError
  field :stack, 14, type: :string
  field :context_snapshot_json, 15, type: :bytes, json_name: "contextSnapshotJson"
  field :http_status, 16, type: :int32, json_name: "httpStatus"
  field :retryable, 17, type: :bool
  field :retry_after_ms, 18, type: :int64, json_name: "retryAfterMs"
  field :details_json, 19, type: :bytes, json_name: "detailsJson"
end

defmodule Blok.Runtime.V1.ListNodesRequest do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3
end

defmodule Blok.Runtime.V1.ListNodesResponse do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :nodes, 1, repeated: true, type: Blok.Runtime.V1.NodeDescriptor
  field :sdk_name, 2, type: :string, json_name: "sdkName"
  field :sdk_version, 3, type: :string, json_name: "sdkVersion"
  field :proto_version, 4, type: :string, json_name: "protoVersion"
  field :capabilities, 5, repeated: true, type: :string
end

defmodule Blok.Runtime.V1.NodeDescriptor do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :name, 1, type: :string
  field :description, 2, type: :string
  field :input_schema_json, 3, type: :bytes, json_name: "inputSchemaJson"
  field :output_schema_json, 4, type: :bytes, json_name: "outputSchemaJson"
  field :tags, 5, repeated: true, type: :string
  field :capability_manifest_json, 6, type: :bytes, json_name: "capabilityManifestJson"
end

defmodule Blok.Runtime.V1.HealthRequest do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :service, 1, type: :string
end

defmodule Blok.Runtime.V1.HealthResponse.Status do
  @moduledoc false
  use Protobuf, enum: true, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :UNKNOWN, 0
  field :SERVING, 1
  field :NOT_SERVING, 2
end

defmodule Blok.Runtime.V1.HealthResponse do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :status, 1, type: Blok.Runtime.V1.HealthResponse.Status, enum: true
  field :sdk_version, 2, type: :string, json_name: "sdkVersion"
  field :registered_nodes, 3, repeated: true, type: :string, json_name: "registeredNodes"
end

defmodule Blok.Runtime.V1.Metrics do
  @moduledoc false
  use Protobuf, protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field :duration_ms, 1, type: :double, json_name: "durationMs"
  field :cpu_ms, 2, type: :double, json_name: "cpuMs"
  field :memory_bytes, 3, type: :int64, json_name: "memoryBytes"
  field :request_bytes, 4, type: :int64, json_name: "requestBytes"
  field :response_bytes, 5, type: :int64, json_name: "responseBytes"
end

defmodule Blok.Runtime.V1.NodeRuntime.Service do
  @moduledoc false

  use GRPC.Service, name: "blok.runtime.v1.NodeRuntime", protoc_gen_elixir_version: "0.17.0"

  rpc :Execute, Blok.Runtime.V1.ExecuteRequest, Blok.Runtime.V1.ExecuteResponse

  rpc :ExecuteStream, Blok.Runtime.V1.ExecuteRequest, stream(Blok.Runtime.V1.ExecuteEvent)

  rpc :Health, Blok.Runtime.V1.HealthRequest, Blok.Runtime.V1.HealthResponse

  rpc :ListNodes, Blok.Runtime.V1.ListNodesRequest, Blok.Runtime.V1.ListNodesResponse
end

defmodule Blok.Runtime.V1.NodeRuntime.Stub do
  @moduledoc false

  use GRPC.Stub, service: Blok.Runtime.V1.NodeRuntime.Service
end
