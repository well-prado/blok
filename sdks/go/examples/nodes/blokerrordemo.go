package nodes

import (
	"errors"
	"fmt"

	blok "github.com/nickincloud/blok-go"
)

// BlokErrorDemoNode demonstrates the structured BlokError API per master
// plan §17. Used by the cross-language E2E test (`go-grpc.integration.test.ts`)
// to verify that a Go-side structured error flows through the gRPC wire to
// the runner with every field preserved.
//
// Triggered via the `mode` config:
//
//   - mode="dependency" (default) — returns BlokError.dependency with a cause
//     chain rooted in a vanilla Go error.
//   - mode="rate-limit" — returns BlokError.rate_limit with retry_after_ms.
//   - mode="validation" — returns BlokError.validation with details.issues.
//   - mode="ok" — returns success.
type BlokErrorDemoNode struct{}

// Execute matches the blok.NodeHandler signature.
func (n *BlokErrorDemoNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	mode, _ := config["mode"].(string)
	if mode == "" {
		mode = "dependency"
	}

	if mode == "ok" {
		return map[string]interface{}{"ok": true, "language": "go"}, nil
	}

	snapshot := blok.BuildContextSnapshot(config, ctx.Vars)

	if mode == "rate-limit" {
		return nil, blok.NewError(blok.CategoryRateLimit).
			Code("UPSTREAM_RATE_LIMITED").
			Message("Upstream API returned 429").
			Description("GitHub API rate limit hit (5000 req/hr).").
			Remediation("Wait until the X-RateLimit-Reset header timestamp.").
			RetryAfterMs(60_000).
			DocURL("https://docs.example.com/errors/rate-limit").
			Details(map[string]interface{}{"limit": 5000, "remaining": 0}).
			ContextSnapshot(snapshot).
			Build()
	}

	if mode == "validation" {
		return nil, blok.NewError(blok.CategoryValidation).
			Code("VALIDATION_FAILED").
			Message("2 validation issues").
			Description("Inputs didn't match the node's schema.").
			Remediation("Provide both `email` and `name`.").
			Details(map[string]interface{}{
				"issues": []map[string]interface{}{
					{"path": []string{"email"}, "message": "Required"},
					{"path": []string{"name"}, "message": "Required"},
				},
			}).
			ContextSnapshot(snapshot).
			Build()
	}

	// default: dependency with a cause chain
	cause := errors.New("[Errno 61] Connection refused")
	return nil, blok.NewError(blok.CategoryDependency).
		Code("POSTGRES_CONNECT_TIMEOUT").
		Message("Could not connect to Postgres within 5s").
		Description(fmt.Sprintf("Tried host=%s port=%d; timeout=%dms", "db.internal", 5432, 5000)).
		Remediation("Check DATABASE_URL env var and network reachability").
		Cause(cause).
		Retryable(true).
		RetryAfterMs(5_000).
		DocURL("https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT").
		Details(map[string]interface{}{"host": "db.internal", "port": 5432, "timeout_ms": 5000}).
		ContextSnapshot(snapshot).
		Build()
}
