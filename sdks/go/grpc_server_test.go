// End-to-end gRPC tests for the Go SDK.
//
// Spins up `BlokNodeRuntime` on a random port and exercises every RPC of
// the v1 contract via a real gRPC client connection. Mirrors the Rust SDK's
// `tests/grpc_integration.rs` structure.

package blok

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/nickincloud/blok-go/genpb/blok/runtime/v1"
)

// =============================================================================
// Codec unit tests
// =============================================================================

func TestEncodeJSONBytesRoundTrip(t *testing.T) {
	samples := []interface{}{
		map[string]interface{}{"a": float64(1), "b": "two"},
		[]interface{}{float64(1), float64(2), float64(3)},
		"plain string",
		float64(42),
		true,
	}
	for _, s := range samples {
		blob := encodeJSONBytes(s)
		var got interface{}
		if err := json.Unmarshal(blob, &got); err != nil {
			t.Fatalf("unmarshal failed for %v: %v", s, err)
		}
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(s)
		if string(gotJSON) != string(wantJSON) {
			t.Errorf("round trip mismatch: want %s, got %s", wantJSON, gotJSON)
		}
	}
}

func TestEncodeJSONBytesEmptyForUnencodable(t *testing.T) {
	blob := encodeJSONBytes(make(chan int))
	if blob != nil {
		t.Errorf("expected nil bytes for unencodable, got %v", blob)
	}
}

func TestDecodeJSONObjectEmpty(t *testing.T) {
	m, err := decodeJSONObject(nil, "x")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(m) != 0 {
		t.Errorf("expected empty map, got %v", m)
	}
}

func TestDecodeJSONObjectWrapsNonObjectPayloads(t *testing.T) {
	m, err := decodeJSONObject([]byte("[1,2,3]"), "inputs")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := m["_value"]; !ok {
		t.Errorf("expected non-object to be wrapped under _value, got %v", m)
	}
}

func TestDecodeJSONObjectRaisesOnMalformedJSON(t *testing.T) {
	_, err := decodeJSONObject([]byte("not json"), "inputs")
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestDecodeRequestBodyParsesJSON(t *testing.T) {
	body := decodeRequestBody(
		[]byte(`{"hello":"world"}`),
		map[string]string{"content-type": "application/json"},
	)
	m, ok := body.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map, got %T", body)
	}
	if m["hello"] != "world" {
		t.Errorf("unexpected body: %v", m)
	}
}

func TestDecodeRequestBodyReturnsStringForOtherContentTypes(t *testing.T) {
	body := decodeRequestBody([]byte("plain text"), map[string]string{"content-type": "text/plain"})
	if body != "plain text" {
		t.Errorf("expected raw string, got %v", body)
	}
}

func TestDecodeRequestBodyHandlesCapitalizedHeader(t *testing.T) {
	body := decodeRequestBody([]byte(`"x"`), map[string]string{"Content-Type": "application/json"})
	if body != "x" {
		t.Errorf("expected x, got %v", body)
	}
}

// =============================================================================
// Test fixtures — server, client, helpers
// =============================================================================

// echoNode echoes its config back as data.
type echoNode struct{}

func (n *echoNode) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
	if config == nil {
		return map[string]interface{}{}, nil
	}
	return config, nil
}

// greetNode mirrors the example helloworld for cross-runtime parity.
type greetNode struct{}

func (n *greetNode) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
	prefix := "Hello"
	if v, ok := config["prefix"].(string); ok && v != "" {
		prefix = v
	}
	name := "World"
	if body := ctx.Request.BodyMap(); body != nil {
		if v, ok := body["name"].(string); ok && v != "" {
			name = v
		}
	}
	ctx.SetVar("greeting", fmt.Sprintf("%s, %s!", prefix, name))
	return map[string]interface{}{
		"message":  fmt.Sprintf("%s, %s!", prefix, name),
		"language": "go",
	}, nil
}

func startTestServer(t *testing.T) (*grpc.Server, string, func()) {
	t.Helper()

	registry := NewNodeRegistry()
	registry.Register("echo", &echoNode{})
	registry.Register("greet", &greetNode{})

	// Reserve a free port.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := lis.Addr().String()

	server := grpc.NewServer()
	pb.RegisterNodeRuntimeServer(server, NewBlokNodeRuntime(registry, "1.0.0-test"))

	go func() {
		_ = server.Serve(lis)
	}()

	// Give the server a beat to bind.
	time.Sleep(50 * time.Millisecond)

	return server, addr, func() { server.Stop() }
}

func dialTestClient(t *testing.T, addr string) (pb.NodeRuntimeClient, func()) {
	t.Helper()

	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	return pb.NewNodeRuntimeClient(conn), func() { _ = conn.Close() }
}

func makeRequest(nodeName string, inputs map[string]interface{}, body interface{}) *pb.ExecuteRequest {
	var bodyBytes []byte
	headers := map[string]string{}
	if body != nil {
		bodyBytes = encodeJSONBytes(body)
		headers["content-type"] = "application/json"
	}
	return &pb.ExecuteRequest{
		Node: &pb.NodeRef{Name: nodeName, Type: "runtime.go"},
		Inputs: encodeJSONBytes(inputs),
		Step: &pb.StepInfo{Name: nodeName, Index: 0, Total: 1, Depth: 0},
		Trigger: &pb.TriggerInfo{
			Body:        bodyBytes,
			Headers:     headers,
			Method:      "POST",
			Url:         "/",
			TriggerKind: "http",
		},
		State: &pb.RuntimeState{},
		Workflow: &pb.WorkflowInfo{
			RunId:   "test-run",
			Name:    "test-wf",
			Path:    "/test",
			Version: "1.0.0",
		},
		Options: &pb.ExecuteOptions{
			DeadlineMs:     5000,
			CaptureMetrics: true,
		},
	}
}

// =============================================================================
// Integration tests
// =============================================================================

func TestExecuteReturnsSuccessWithUnwrappedInputs(t *testing.T) {
	_, addr, stop := startTestServer(t)
	defer stop()
	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	inputs := map[string]interface{}{"msg": "hello", "n": float64(42)}
	resp, err := client.Execute(context.Background(), makeRequest("echo", inputs, nil))
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if !resp.Success {
		t.Fatalf("expected success=true, got false")
	}
	if resp.Error != nil && resp.Error.Code != "" {
		t.Errorf("unexpected error: %v", resp.Error)
	}

	var got map[string]interface{}
	if err := json.Unmarshal(resp.Data, &got); err != nil {
		t.Fatalf("response data not JSON: %v", err)
	}
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", inputs) {
		t.Errorf("inputs not echoed unwrapped — closes FIXES.md #3 only if matches\nwant %v\ngot  %v", inputs, got)
	}
}

func TestExecuteGreetCrossRuntimeParity(t *testing.T) {
	_, addr, stop := startTestServer(t)
	defer stop()
	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	resp, err := client.Execute(
		context.Background(),
		makeRequest("greet", map[string]interface{}{"prefix": "Hi"}, map[string]interface{}{"name": "Blok"}),
	)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success=true")
	}
	var got map[string]interface{}
	_ = json.Unmarshal(resp.Data, &got)
	if got["message"] != "Hi, Blok!" {
		t.Errorf("expected greeting 'Hi, Blok!', got %q", got["message"])
	}
	if got["language"] != "go" {
		t.Errorf("expected language=go, got %q", got["language"])
	}
}

func TestExecuteReturnsStructuredErrorForMissingNode(t *testing.T) {
	_, addr, stop := startTestServer(t)
	defer stop()
	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	resp, err := client.Execute(context.Background(), makeRequest("does-not-exist", nil, nil))
	if err != nil {
		t.Fatalf("RPC itself should succeed; failure surfaces in body: %v", err)
	}
	if resp.Success {
		t.Fatal("expected success=false for missing node")
	}
	if resp.Error == nil {
		t.Fatal("expected error populated on failure")
	}
	if resp.Error.Sdk != "blok-go" {
		t.Errorf("expected sdk=blok-go, got %q", resp.Error.Sdk)
	}
	if resp.Error.RuntimeKind != "runtime.go" {
		t.Errorf("expected runtime_kind=runtime.go, got %q", resp.Error.RuntimeKind)
	}
	if !strings.Contains(strings.ToLower(resp.Error.Message), "not found") {
		t.Errorf("expected 'not found' in message, got %q", resp.Error.Message)
	}
}

func TestHealthReportsServingWithRegisteredNodes(t *testing.T) {
	_, addr, stop := startTestServer(t)
	defer stop()
	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	resp, err := client.Health(context.Background(), &pb.HealthRequest{Service: "blok.runtime.v1.NodeRuntime"})
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if resp.Status != pb.HealthResponse_SERVING {
		t.Errorf("expected SERVING, got %v", resp.Status)
	}
	if resp.SdkVersion != "1.0.0-test" {
		t.Errorf("expected sdk_version=1.0.0-test, got %q", resp.SdkVersion)
	}
	names := map[string]bool{}
	for _, n := range resp.RegisteredNodes {
		names[n] = true
	}
	if !names["echo"] || !names["greet"] {
		t.Errorf("expected echo + greet in registered_nodes, got %v", resp.RegisteredNodes)
	}
}

func TestListNodesReturnsRegisteredDescriptors(t *testing.T) {
	_, addr, stop := startTestServer(t)
	defer stop()
	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	resp, err := client.ListNodes(context.Background(), &pb.ListNodesRequest{})
	if err != nil {
		t.Fatalf("ListNodes: %v", err)
	}
	if resp.SdkName != "blok-go" {
		t.Errorf("expected sdk_name=blok-go, got %q", resp.SdkName)
	}
	if resp.SdkVersion != "1.0.0-test" {
		t.Errorf("expected sdk_version=1.0.0-test, got %q", resp.SdkVersion)
	}
	if resp.ProtoVersion != "1.0.0" {
		t.Errorf("expected proto_version=1.0.0, got %q", resp.ProtoVersion)
	}
	if len(resp.Nodes) < 2 {
		t.Errorf("expected ≥2 nodes registered, got %d", len(resp.Nodes))
	}
}

func TestExecuteStreamEmitsStartedThenFinal(t *testing.T) {
	_, addr, stop := startTestServer(t)
	defer stop()
	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	stream, err := client.ExecuteStream(context.Background(), makeRequest("echo", map[string]any{"hi": 1}, nil))
	if err != nil {
		t.Fatalf("ExecuteStream call failed: %v", err)
	}

	var events []*pb.ExecuteEvent
	for {
		ev, recvErr := stream.Recv()
		if recvErr == io.EOF {
			break
		}
		if recvErr != nil {
			t.Fatalf("Recv failed: %v", recvErr)
		}
		events = append(events, ev)
	}

	if len(events) < 2 {
		t.Fatalf("expected at least 2 events (started, final), got %d", len(events))
	}
	if _, ok := events[0].GetEvent().(*pb.ExecuteEvent_Started); !ok {
		t.Errorf("expected first event = NodeStarted, got %T", events[0].GetEvent())
	}
	last, ok := events[len(events)-1].GetEvent().(*pb.ExecuteEvent_Final)
	if !ok {
		t.Fatalf("expected last event = ExecuteResponse, got %T", events[len(events)-1].GetEvent())
	}
	if !last.Final.Success {
		t.Errorf("expected final.success=true, got false")
	}
}

// loggingNode emits log lines via ctx.StreamLog before sleeping. Used to
// verify the ExecuteStream real-time path: logs must arrive in the
// stream BEFORE the handler returns, not buffered until completion.
type loggingNode struct{}

func (n *loggingNode) Execute(ctx *Context, _ map[string]any) (any, error) {
	ctx.StreamLog(StreamLogEntry{
		Level:   "info",
		Message: "emitted-before-sleep",
		Attrs:   map[string]string{"phase": "early"},
	})
	time.Sleep(300 * time.Millisecond)
	ctx.StreamLog(StreamLogEntry{Level: "warning", Message: "almost-done"})
	return map[string]any{"ok": true}, nil
}

func TestExecuteStreamRealTimeEmitsLogBeforeFinal(t *testing.T) {
	// Bring up a server with a node that emits a log THEN sleeps —
	// the real-time path must surface the log frame before the
	// 300 ms sleep completes (Phase 5 polish per master plan §17
	// follow-up).
	registry := NewNodeRegistry()
	registry.Register("loggy", &loggingNode{})

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := lis.Addr().String()

	server := grpc.NewServer()
	pb.RegisterNodeRuntimeServer(server, NewBlokNodeRuntime(registry, "1.0.0-test"))
	go func() { _ = server.Serve(lis) }()
	defer server.Stop()
	time.Sleep(50 * time.Millisecond)

	client, closeClient := dialTestClient(t, addr)
	defer closeClient()

	startedAt := time.Now()
	stream, err := client.ExecuteStream(context.Background(), makeRequest("loggy", nil, nil))
	if err != nil {
		t.Fatalf("ExecuteStream: %v", err)
	}

	var firstLogAt time.Time
	var finalAt time.Time
	for {
		ev, recvErr := stream.Recv()
		if recvErr == io.EOF {
			break
		}
		if recvErr != nil {
			t.Fatalf("Recv: %v", recvErr)
		}
		switch ev.GetEvent().(type) {
		case *pb.ExecuteEvent_Log:
			if firstLogAt.IsZero() {
				firstLogAt = time.Now()
			}
		case *pb.ExecuteEvent_Final:
			finalAt = time.Now()
		}
	}

	if firstLogAt.IsZero() {
		t.Fatalf("no log frame received")
	}
	if finalAt.IsZero() {
		t.Fatalf("no final frame received")
	}

	// Critical assertion: first log arrived BEFORE the final
	// frame, AND much earlier than the handler's 300 ms sleep
	// would have completed if we'd been buffering.
	logLag := firstLogAt.Sub(startedAt)
	totalLag := finalAt.Sub(startedAt)
	if firstLogAt.After(finalAt) {
		t.Fatalf("first log arrived after final frame (log %v, final %v)", logLag, totalLag)
	}
	// 200 ms ceiling absorbs gRPC framing latency; the buffered model
	// would yield logLag ≥ 300 ms (handler sleep duration).
	if logLag > 200*time.Millisecond {
		t.Fatalf("first log arrived %v after start (expected <200ms; buffered model would be ≥300ms)", logLag)
	}
}
