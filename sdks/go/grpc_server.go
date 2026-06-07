// gRPC server implementing the canonical Blok NodeRuntime v1 service.
//
// Wire contract: proto/blok/runtime/v1/runtime.proto. Generated stubs live
// in github.com/nickincloud/blok-go/genpb/blok/runtime/v1.
//
// Architecture
// ------------
//   - BlokNodeRuntime is the gRPC service implementation. It owns a pointer
//     to the shared NodeRegistry so a single registry can serve both HTTP
//     and gRPC.
//   - ServeGrpc builds the gRPC server, binds the port, and blocks until
//     shutdown (or the listener is closed).
//   - Codec helpers (decodeExecuteRequest / encodeExecuteResponse / etc.)
//     sit at the boundary between proto and the SDK's internal
//     ExecutionRequest / ExecutionResult types so NodeRegistry.Execute runs
//     unchanged regardless of which transport delivered the request.
//
// The proto sends inputs, previous_output, vars, and the request body as
// raw JSON-encoded bytes. The SDK JSON-decodes them lazily.

package blok

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/nickincloud/blok-go/genpb/blok/runtime/v1"
)

// =============================================================================
// Service implementation
// =============================================================================

// BlokNodeRuntime is the gRPC implementation of the v1 NodeRuntime service.
//
// Single Responsibility: translate proto messages into the SDK's internal
// ExecutionRequest / ExecutionResult and dispatch to NodeRegistry. All
// node-level error handling lives in NodeRegistry.Execute.
type BlokNodeRuntime struct {
	pb.UnimplementedNodeRuntimeServer
	registry   *NodeRegistry
	sdkVersion string
}

// NewBlokNodeRuntime returns a BlokNodeRuntime bound to the given registry.
func NewBlokNodeRuntime(registry *NodeRegistry, sdkVersion string) *BlokNodeRuntime {
	if sdkVersion == "" {
		sdkVersion = "1.0.0"
	}
	return &BlokNodeRuntime{registry: registry, sdkVersion: sdkVersion}
}

// Execute decodes the proto envelope, dispatches to the registry, and
// encodes the result back to a proto response.
func (s *BlokNodeRuntime) Execute(ctx context.Context, req *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	execReq, err := decodeExecuteRequest(req)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	result := s.registry.Execute(execReq)
	return encodeExecuteResponse(result, execReq.Node.Name, s.sdkVersion), nil
}

// ExecuteStream is the server-streaming variant of Execute.
//
// Emits, in order:
//  1. one NodeStarted event marking call acceptance
//  2. zero or more LogLine events emitted by the handler via
//     `ctx.StreamLog(...)` while it runs (real-time, not buffered)
//  3. one terminal ExecuteResponse carrying the same payload as the unary
//     Execute would return
//
// # Real-time streaming model
//
// The handler runs on its own goroutine so the request goroutine can
// `select` on the log channel and the result channel concurrently. Every
// time the handler calls `ctx.StreamLog`, an entry lands on the log
// channel; the request goroutine wakes, sends a LogLine proto, and goes
// back to selecting. When the handler returns, the result lands on the
// result channel; we drain any remaining log entries (preserving causal
// order with respect to the final response) and send the
// ExecuteResponse.
//
// # Drop policy under load
//
// The log channel is buffered (default 64). If a handler emits faster
// than the gRPC stream can drain (very rare in practice), additional
// `StreamLog` calls drop the entry rather than block — observability
// over correctness; a chatty handler does not stall execution.
func (s *BlokNodeRuntime) ExecuteStream(req *pb.ExecuteRequest, stream pb.NodeRuntime_ExecuteStreamServer) error {
	execReq, err := decodeExecuteRequest(req)
	if err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}

	// NodeStarted goes out immediately so the runner can record start time
	// before the (potentially long) execute call.
	if sendErr := stream.Send(&pb.ExecuteEvent{
		Event: &pb.ExecuteEvent_Started{
			Started: &pb.NodeStarted{At: timestamppb.New(time.Now())},
		},
	}); sendErr != nil {
		return sendErr
	}

	// Channel-backed logger sink. Buffered to absorb bursts without
	// blocking the handler; non-blocking drop on overflow.
	const logBufSize = 64
	logCh := make(chan StreamLogEntry, logBufSize)
	execReq.Context.setStreamLog(func(entry StreamLogEntry) {
		select {
		case logCh <- entry:
		default:
			// Buffer full — drop the entry.
		}
	})

	// Run the handler on a worker goroutine so we can multiplex log
	// frames and the final result on the request goroutine.
	resultCh := make(chan *ExecutionResult, 1)
	go func() {
		resultCh <- s.registry.Execute(execReq)
	}()

	// Streaming loop: forward each log frame as it arrives; break
	// when the handler returns.
	var result *ExecutionResult
	streaming := true
	for streaming {
		select {
		case entry := <-logCh:
			if sendErr := stream.Send(&pb.ExecuteEvent{
				Event: &pb.ExecuteEvent_Log{Log: streamLogEntryToProto(entry)},
			}); sendErr != nil {
				return sendErr
			}
		case result = <-resultCh:
			streaming = false
		}
	}

	// Detach the sink so a delayed handler goroutine can't accidentally
	// publish to the closing channel.
	execReq.Context.setStreamLog(nil)

	// Drain any logs the handler emitted between our last `select`
	// wakeup and its final return so they arrive before the final
	// frame.
draining:
	for {
		select {
		case entry := <-logCh:
			if sendErr := stream.Send(&pb.ExecuteEvent{
				Event: &pb.ExecuteEvent_Log{Log: streamLogEntryToProto(entry)},
			}); sendErr != nil {
				return sendErr
			}
		default:
			break draining
		}
	}

	return stream.Send(&pb.ExecuteEvent{
		Event: &pb.ExecuteEvent_Final{
			Final: encodeExecuteResponse(result, execReq.Node.Name, s.sdkVersion),
		},
	})
}

// streamLogEntryToProto encodes a handler-emitted StreamLogEntry into the
// proto LogLine wire shape. The proto `timestamp` field captures
// wall-clock at encode time (the entry's emit moment is captured here
// in the request goroutine, microseconds after the handler returned
// from StreamLog).
func streamLogEntryToProto(entry StreamLogEntry) *pb.LogLine {
	return &pb.LogLine{
		Timestamp:  timestamppb.New(time.Now()),
		Level:      entry.Level,
		Message:    entry.Message,
		Attributes: entry.Attrs,
	}
}

// Health reports SERVING with the SDK version and registered node names.
// Wire-compatible with grpc.health.v1.Health/Check.
func (s *BlokNodeRuntime) Health(ctx context.Context, req *pb.HealthRequest) (*pb.HealthResponse, error) {
	return &pb.HealthResponse{
		Status:          pb.HealthResponse_SERVING,
		SdkVersion:      s.sdkVersion,
		RegisteredNodes: s.registry.NodeNames(),
	}, nil
}

// ListNodes returns the registered node names as descriptors.
func (s *BlokNodeRuntime) ListNodes(ctx context.Context, req *pb.ListNodesRequest) (*pb.ListNodesResponse, error) {
	names := s.registry.NodeNames()
	descriptors := make([]*pb.NodeDescriptor, 0, len(names))
	for _, name := range names {
		// SPEC-B P4 — DefineNode handlers expose a description + JSON Schema via
		// NodeReflector; legacy map-based handlers report empty.
		var description string
		var inputSchema, outputSchema []byte
		if h, err := s.registry.Get(name); err == nil {
			if r, ok := h.(NodeReflector); ok {
				description = r.Description()
				inputSchema = r.InputSchemaJSON()
				outputSchema = r.OutputSchemaJSON()
			}
		}
		descriptors = append(descriptors, &pb.NodeDescriptor{
			Name:             name,
			Description:      description,
			InputSchemaJson:  inputSchema,
			OutputSchemaJson: outputSchema,
			Tags:             nil,
		})
	}
	return &pb.ListNodesResponse{
		Nodes:        descriptors,
		SdkName:      "blok-go",
		SdkVersion:   s.sdkVersion,
		ProtoVersion: "1.0.0",
	}, nil
}

// =============================================================================
// Server lifecycle
// =============================================================================

// GrpcServerOptions controls how ServeGrpc binds and configures the gRPC
// server. Zero values are replaced by sensible defaults.
type GrpcServerOptions struct {
	// MaxMessageBytes limits the maximum send/receive size. Defaults to
	// 16 MiB (matches the runner-side default + the PHP-buffer ceiling
	// from BLOK_FRAMEWORK_FIXES.md #5).
	MaxMessageBytes int
	// SdkVersion is reported in Health and ListNodes responses.
	SdkVersion string
}

// ServeGrpc binds the gRPC server on host:port and blocks until the server
// stops (or returns a startup error). The returned grpc.Server lets callers
// stop the server gracefully when blocking is delegated to the caller.
//
// For non-blocking startup (so a process can listen on HTTP and gRPC at the
// same time), see StartGrpc which returns the started server immediately.
func ServeGrpc(registry *NodeRegistry, host string, port int, opts GrpcServerOptions) error {
	server, lis, err := buildGrpcServer(registry, host, port, opts)
	if err != nil {
		return err
	}
	log.Printf("Blok gRPC server (NodeRuntime v1) listening on %s with %d nodes registered",
		lis.Addr().String(), len(registry.NodeNames()))
	return server.Serve(lis)
}

// StartGrpc binds and starts the gRPC server in a background goroutine.
// Returns the server immediately so the caller can stop it via Stop or
// GracefulStop. Errors during Serve are logged.
//
// Use this for dual-listen mode where the same process serves HTTP and gRPC.
func StartGrpc(registry *NodeRegistry, host string, port int, opts GrpcServerOptions) (*grpc.Server, net.Addr, error) {
	server, lis, err := buildGrpcServer(registry, host, port, opts)
	if err != nil {
		return nil, nil, err
	}
	go func() {
		log.Printf("Blok gRPC server (NodeRuntime v1) listening on %s with %d nodes registered",
			lis.Addr().String(), len(registry.NodeNames()))
		if serveErr := server.Serve(lis); serveErr != nil && !errors.Is(serveErr, grpc.ErrServerStopped) {
			log.Printf("gRPC server error: %v", serveErr)
		}
	}()
	return server, lis.Addr(), nil
}

func buildGrpcServer(registry *NodeRegistry, host string, port int, opts GrpcServerOptions) (*grpc.Server, net.Listener, error) {
	maxMsg := opts.MaxMessageBytes
	if maxMsg <= 0 {
		maxMsg = 16 * 1024 * 1024
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("listen on %s: %w", addr, err)
	}

	server := grpc.NewServer(
		grpc.MaxRecvMsgSize(maxMsg),
		grpc.MaxSendMsgSize(maxMsg),
	)
	pb.RegisterNodeRuntimeServer(server, NewBlokNodeRuntime(registry, opts.SdkVersion))
	return server, lis, nil
}

// =============================================================================
// Codec — proto ↔ internal types
// =============================================================================

// decodeError signals an unrecoverable problem in incoming proto messages.
type decodeError struct{ msg string }

func (e *decodeError) Error() string { return e.msg }

// decodeExecuteRequest decodes a proto ExecuteRequest into the SDK's
// ExecutionRequest. The opaque JSON-shaped fields (inputs, previous_output,
// vars, request body) arrive as raw bytes and are JSON-decoded here.
func decodeExecuteRequest(req *pb.ExecuteRequest) (*ExecutionRequest, error) {
	if req == nil || req.Node == nil || req.Node.Name == "" {
		return nil, &decodeError{msg: "ExecuteRequest.node is required"}
	}

	inputs, err := decodeJSONObject(req.Inputs, "inputs")
	if err != nil {
		return nil, err
	}

	previousOutput, err := decodeJSONValue(req.GetState().GetPreviousOutput(), "previous_output")
	if err != nil {
		return nil, err
	}

	vars, err := decodeJSONObject(req.GetState().GetVars(), "vars")
	if err != nil {
		return nil, err
	}

	trigger := req.GetTrigger()
	body := decodeRequestBody(trigger.GetBody(), trigger.GetHeaders())

	exec := &ExecutionRequest{
		Node: NodeConfig{
			Name:   req.Node.Name,
			Type:   req.Node.Type,
			Config: inputs,
		},
		Context: Context{
			ID:           req.GetWorkflow().GetRunId(),
			WorkflowName: req.GetWorkflow().GetName(),
			WorkflowPath: req.GetWorkflow().GetPath(),
			Request: Request{
				Body:    body,
				Headers: trigger.GetHeaders(),
				Params:  trigger.GetParams(),
				Query:   trigger.GetQuery(),
				Method:  trigger.GetMethod(),
				URL:     trigger.GetUrl(),
				Cookies: trigger.GetCookies(),
				BaseURL: trigger.GetBaseUrl(),
			},
			Response: Response{
				Data:        previousOutput,
				ContentType: "application/json",
				Success:     true,
				Error:       nil,
			},
			Vars: vars,
			Env:  req.GetState().GetEnv(),
		},
	}
	return exec, nil
}

// encodeExecuteResponse encodes the SDK's ExecutionResult into a proto
// ExecuteResponse.
func encodeExecuteResponse(result *ExecutionResult, nodeName string, sdkVersion string) *pb.ExecuteResponse {
	var metrics *pb.Metrics
	if result.Metrics != nil {
		var dur, cpu float64
		var mem int64
		if result.Metrics.DurationMs != nil {
			dur = *result.Metrics.DurationMs
		}
		if result.Metrics.CpuMs != nil {
			cpu = *result.Metrics.CpuMs
		}
		if result.Metrics.MemoryBytes != nil {
			mem = int64(*result.Metrics.MemoryBytes)
		}
		metrics = &pb.Metrics{
			DurationMs:  dur,
			CpuMs:       cpu,
			MemoryBytes: mem,
		}
	}

	var dataBytes []byte
	if result.Success && result.Data != nil {
		dataBytes = encodeJSONBytes(result.Data)
	}

	var varsDeltaBytes []byte
	if len(result.Vars) > 0 {
		varsDeltaBytes = encodeJSONBytes(result.Vars)
	}

	var nodeError *pb.NodeError
	if !result.Success {
		nodeError = internalErrorToProto(result.Errors, nodeName, sdkVersion)
	}

	// Populate `response_bytes` so Studio's run-detail Inspector can
	// display the gRPC wire size next to the request bytes the runner
	// already measures. Approximate via the JSON-encoded payload size
	// (data + vars_delta) — matches the runner's request_bytes
	// approximation, so the two numbers are comparable.
	if metrics == nil {
		metrics = &pb.Metrics{}
	}
	metrics.ResponseBytes = int64(len(dataBytes) + len(varsDeltaBytes))

	return &pb.ExecuteResponse{
		Success:     result.Success,
		Data:        dataBytes,
		ContentType: "application/json",
		Error:       nodeError,
		VarsDelta:   varsDeltaBytes,
		Logs:        nil,
		Metrics:     metrics,
	}
}

// internalErrorToProto builds a structured NodeError from whatever
// ExecutionResult.Errors carries.
//
// Two paths:
//   - Structured (preferred): errVal is a *BlokError. All 19 fields serialize
//     losslessly via blokErrorToProto. Auto-fills node/sdk/sdk_version/
//     runtime_kind if the BlokError didn't set them itself.
//   - Loose: errVal is anything else (dict, string, nil, error). Wrapped via
//     FromUnknown (always produces category=INTERNAL with the original
//     payload preserved in details_json) and then serialized via the
//     structured path.
//
// Both paths produce the same proto shape, so the runner's gRPC codec
// consumes them identically.
func internalErrorToProto(errVal interface{}, nodeName, sdkVersion string) *pb.NodeError {
	if blokErr, ok := errVal.(*BlokError); ok {
		blokErr.EnrichOrigin(DefaultOrigin(nodeName, sdkVersion))
		return blokErrorToProto(blokErr)
	}
	return blokErrorToProto(FromUnknown(errVal, DefaultOrigin(nodeName, sdkVersion)))
}

// blokErrorToProto serializes a fully-populated *BlokError into the proto
// wire format. The cause chain is serialized as a list of pb.NodeError
// messages; each element's own causes list is left empty (the chain is
// already flat at the BlokError layer, so nesting at the wire layer would
// double-count).
func blokErrorToProto(e *BlokError) *pb.NodeError {
	at := timestamppb.New(e.At)
	causes := make([]*pb.NodeError, 0, len(e.Causes))
	for _, c := range e.Causes {
		causes = append(causes, causeMapToProto(c))
	}
	return &pb.NodeError{
		Code:                e.Code,
		Category:            categoryToProto(e.Category),
		Severity:            severityToProto(e.Severity),
		Node:                e.Node,
		Sdk:                 e.SDK,
		SdkVersion:          e.SDKVersion,
		RuntimeKind:         e.RuntimeKind,
		At:                  at,
		Message:             e.Message,
		Description:         e.Description,
		Remediation:         e.Remediation,
		DocUrl:              e.DocURL,
		Causes:              causes,
		Stack:               e.Stack,
		ContextSnapshotJson: encodeNullableJSONBytes(e.ContextSnapshot),
		HttpStatus:          int32(e.HTTPStatus),
		Retryable:           e.Retryable,
		RetryAfterMs:        e.RetryAfterMs,
		DetailsJson:         encodeNullableJSONBytes(e.Details),
	}
}

func causeMapToProto(cause map[string]interface{}) *pb.NodeError {
	atTs := timestamppb.Now()
	if atStr, ok := cause["at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, atStr); err == nil {
			atTs = timestamppb.New(parsed)
		}
	}
	httpStatus := 500
	if hs, ok := cause["http_status"].(int); ok {
		httpStatus = hs
	} else if hs, ok := cause["http_status"].(float64); ok {
		httpStatus = int(hs)
	}
	retryAfterMs := int64(0)
	switch v := cause["retry_after_ms"].(type) {
	case int:
		retryAfterMs = int64(v)
	case int64:
		retryAfterMs = v
	case float64:
		retryAfterMs = int64(v)
	}
	retryable := false
	if r, ok := cause["retryable"].(bool); ok {
		retryable = r
	}
	return &pb.NodeError{
		Code:                stringField(cause, "code"),
		Category:            categoryToProto(ErrorCategory(stringField(cause, "category"))),
		Severity:            severityToProto(ErrorSeverity(stringField(cause, "severity"))),
		Node:                stringField(cause, "node"),
		Sdk:                 stringField(cause, "sdk"),
		SdkVersion:          stringField(cause, "sdk_version"),
		RuntimeKind:         stringField(cause, "runtime_kind"),
		At:                  atTs,
		Message:             stringField(cause, "message"),
		Description:         stringField(cause, "description"),
		Remediation:         stringField(cause, "remediation"),
		DocUrl:              stringField(cause, "doc_url"),
		Causes:              []*pb.NodeError{},
		Stack:               stringField(cause, "stack"),
		ContextSnapshotJson: encodeNullableJSONBytes(cause["context_snapshot"]),
		HttpStatus:          int32(httpStatus),
		Retryable:           retryable,
		RetryAfterMs:        retryAfterMs,
		DetailsJson:         encodeNullableJSONBytes(cause["details"]),
	}
}

func stringField(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func encodeNullableJSONBytes(v interface{}) []byte {
	if v == nil {
		return nil
	}
	return encodeJSONBytes(v)
}

// categoryToProto maps a (possibly legacy/unknown) ErrorCategory string to
// the proto integer enum. Unknown values default to INTERNAL — same
// fallback as Python.
func categoryToProto(c ErrorCategory) pb.ErrorCategory {
	switch c {
	case CategoryValidation:
		return pb.ErrorCategory_VALIDATION
	case CategoryConfiguration:
		return pb.ErrorCategory_CONFIGURATION
	case CategoryDependency:
		return pb.ErrorCategory_DEPENDENCY
	case CategoryTimeout:
		return pb.ErrorCategory_TIMEOUT
	case CategoryPermission:
		return pb.ErrorCategory_PERMISSION
	case CategoryRateLimit:
		return pb.ErrorCategory_RATE_LIMIT
	case CategoryNotFound:
		return pb.ErrorCategory_NOT_FOUND
	case CategoryConflict:
		return pb.ErrorCategory_CONFLICT
	case CategoryCancelled:
		return pb.ErrorCategory_CANCELLED
	case CategoryProtocol:
		return pb.ErrorCategory_PROTOCOL
	case CategoryData:
		return pb.ErrorCategory_DATA
	default:
		return pb.ErrorCategory_INTERNAL
	}
}

func severityToProto(s ErrorSeverity) pb.ErrorSeverity {
	switch s {
	case SeverityInfo:
		return pb.ErrorSeverity_INFO
	case SeverityWarn:
		return pb.ErrorSeverity_WARN
	case SeverityFatal:
		return pb.ErrorSeverity_FATAL
	default:
		return pb.ErrorSeverity_ERROR
	}
}


// decodeJSONObject decodes a JSON-bytes field as a map. Empty bytes → empty map.
// Non-object payloads are wrapped under a "_value" key.
func decodeJSONObject(blob []byte, field string) (map[string]interface{}, error) {
	if len(blob) == 0 {
		return map[string]interface{}{}, nil
	}
	var raw interface{}
	if err := json.Unmarshal(blob, &raw); err != nil {
		return nil, &decodeError{msg: fmt.Sprintf("invalid `%s` JSON: %v", field, err)}
	}
	if m, ok := raw.(map[string]interface{}); ok {
		return m, nil
	}
	return map[string]interface{}{"_value": raw}, nil
}

// decodeJSONValue decodes a JSON-bytes field as an arbitrary value. Empty bytes → nil.
func decodeJSONValue(blob []byte, field string) (interface{}, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	var raw interface{}
	if err := json.Unmarshal(blob, &raw); err != nil {
		return nil, &decodeError{msg: fmt.Sprintf("invalid `%s` JSON: %v", field, err)}
	}
	return raw, nil
}

// decodeRequestBody decodes the trigger body. JSON content-types parse as
// JSON; everything else arrives as a raw string for the node to interpret.
func decodeRequestBody(blob []byte, headers map[string]string) interface{} {
	if len(blob) == 0 {
		return nil
	}
	contentType := pickHeader(headers, "content-type")
	if strings.Contains(strings.ToLower(contentType), "application/json") {
		var v interface{}
		if err := json.Unmarshal(blob, &v); err == nil {
			return v
		}
		// fall through to raw-string handling
	}
	return string(blob)
}

func pickHeader(headers map[string]string, name string) string {
	if headers == nil {
		return ""
	}
	if v, ok := headers[name]; ok {
		return v
	}
	// Try case-insensitive lookup.
	for k, v := range headers {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

// encodeJSONBytes encodes a Go value as UTF-8 JSON bytes. Errors fall back
// to nil (the proto receiver treats empty as null).
func encodeJSONBytes(value interface{}) []byte {
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return bytes
}
