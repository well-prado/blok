package blok

import (
	"encoding/json"
	"fmt"

	"github.com/invopop/jsonschema"
)

// NodeReflector is implemented by typed nodes (see DefineNode) to expose a
// description + JSON Schema for the node catalog (GET /__blok/nodes) via gRPC
// ListNodes (SPEC-B P4). Legacy map-based handlers don't implement it.
type NodeReflector interface {
	Description() string
	InputSchemaJSON() []byte
	OutputSchemaJSON() []byte
}

// typedNode is the generic, validated node produced by DefineNode.
type typedNode[I any, O any] struct {
	name        string
	description string
	run         func(ctx *Context, input I) (O, error)
}

// Execute unmarshals the raw config into the typed Input, runs the node, and
// returns the typed Output. A decode failure becomes a structured BlokError.
func (t *typedNode[I, O]) Execute(ctx *Context, config map[string]interface{}) (interface{}, error) {
	raw, err := json.Marshal(config)
	if err != nil {
		return nil, t.validationError(err)
	}
	var input I
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, t.validationError(err)
	}
	return t.run(ctx, input)
}

func (t *typedNode[I, O]) validationError(cause error) error {
	return NewError(CategoryValidation).
		Code("NODE_INPUT_VALIDATION").
		Message(fmt.Sprintf("Input validation failed for node '%s': %v", t.name, cause)).
		HTTPStatus(400).
		Node(t.name).
		Build()
}

func (t *typedNode[I, O]) Description() string      { return t.description }
func (t *typedNode[I, O]) InputSchemaJSON() []byte  { return reflectSchemaJSON[I]() }
func (t *typedNode[I, O]) OutputSchemaJSON() []byte { return reflectSchemaJSON[O]() }

// DefineNode builds a typed node (SPEC-B P4) — the Go equivalent of the
// TypeScript defineNode / Python @node / Rust TypedNode. The raw config is
// unmarshaled into the typed Input (a failure → structured BlokError, HTTP 400),
// `run` receives the typed value, and the JSON Schema of Input/Output is
// reflected (from struct + json/jsonschema tags) for the catalog.
//
// Register it like any handler: registry.Register("@acme/search", DefineNode(...)).
//
//	type Input struct {
//	    Query string `json:"query" jsonschema:"minLength=1"`
//	    Limit int    `json:"limit" jsonschema:"default=10"`
//	}
//	type Output struct {
//	    Results []string `json:"results"`
//	    Count   int      `json:"count"`
//	}
//	registry.Register("@acme/search", blok.DefineNode("@acme/search", "Full-text search",
//	    func(ctx *blok.Context, in Input) (Output, error) {
//	        rows := doSearch(in.Query, in.Limit)
//	        return Output{Results: rows, Count: len(rows)}, nil
//	    }))
func DefineNode[I any, O any](name, description string, run func(ctx *Context, input I) (O, error)) NodeHandler {
	return &typedNode[I, O]{name: name, description: description, run: run}
}

// reflectSchemaJSON returns the JSON-encoded JSON Schema for T, or nil on error.
func reflectSchemaJSON[T any]() []byte {
	r := &jsonschema.Reflector{DoNotReference: true, ExpandedStruct: true}
	schema := r.Reflect(new(T))
	b, err := json.Marshal(schema)
	if err != nil {
		return nil
	}
	return b
}
