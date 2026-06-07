package blok

import (
	"encoding/json"
	"testing"
)

type tdInput struct {
	Query string `json:"query" jsonschema:"minLength=1"`
	Limit int    `json:"limit"`
}

type tdOutput struct {
	Results []string `json:"results"`
	Count   int      `json:"count"`
}

func TestDefineNodeValidatesAndRuns(t *testing.T) {
	h := DefineNode("@acme/search", "Full-text search", func(ctx *Context, in tdInput) (tdOutput, error) {
		return tdOutput{Results: []string{in.Query, in.Query}, Count: in.Limit}, nil
	})
	out, err := h.Execute(&Context{}, map[string]interface{}{"query": "ada", "limit": 2})
	if err != nil {
		t.Fatal(err)
	}
	o, ok := out.(tdOutput)
	if !ok {
		t.Fatalf("expected tdOutput, got %T", out)
	}
	if o.Count != 2 || len(o.Results) != 2 || o.Results[0] != "ada" {
		t.Fatalf("unexpected output: %+v", o)
	}
}

func TestDefineNodeInvalidInputYieldsBlokError(t *testing.T) {
	h := DefineNode("@acme/n", "", func(ctx *Context, in tdInput) (tdOutput, error) {
		return tdOutput{}, nil
	})
	// `limit` is an int; a string can't unmarshal into it → structured error.
	_, err := h.Execute(&Context{}, map[string]interface{}{"query": "x", "limit": "not-a-number"})
	if err == nil {
		t.Fatal("expected a validation error")
	}
	be, ok := err.(*BlokError)
	if !ok {
		t.Fatalf("expected *BlokError, got %T", err)
	}
	if be.HTTPStatus != 400 || be.Code != "NODE_INPUT_VALIDATION" {
		t.Fatalf("unexpected error: status=%d code=%s", be.HTTPStatus, be.Code)
	}
}

func TestDefineNodeReflection(t *testing.T) {
	h := DefineNode("@acme/r", "desc", func(ctx *Context, in tdInput) (tdOutput, error) {
		return tdOutput{}, nil
	})
	r, ok := h.(NodeReflector)
	if !ok {
		t.Fatal("DefineNode result must implement NodeReflector")
	}
	if r.Description() != "desc" {
		t.Fatalf("description: %q", r.Description())
	}
	var inSchema map[string]interface{}
	if err := json.Unmarshal(r.InputSchemaJSON(), &inSchema); err != nil {
		t.Fatalf("input schema not valid JSON: %v", err)
	}
	props, _ := inSchema["properties"].(map[string]interface{})
	if _, has := props["query"]; !has {
		t.Fatalf("input schema missing 'query' property: %v", inSchema)
	}
	if len(r.OutputSchemaJSON()) == 0 {
		t.Fatal("empty output schema")
	}
}
