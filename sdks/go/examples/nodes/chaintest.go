package nodes

import (
	"time"

	blok "github.com/nickincloud/blok-go"
)

// ChainTestNode is used in cross-runtime integration tests.
// It reads a chain array from the request body, appends its own entry,
// and returns the updated chain — proving data flows between languages.
type ChainTestNode struct{}

// Execute processes the chain-test node.
//
// Reads `chain` and `origin` from the resolved step inputs first
// (the gRPC wire shape carries them on `node.config`), falling back
// to `ctx.Request.BodyMap()` for the legacy HTTP path where the
// runner mapped `resolvedInputs → request.body`. This dual-read
// keeps the cross-runtime-chain demo working over both transports
// during the §11 deprecation window.
func (n *ChainTestNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	body := ctx.Request.BodyMap()

	// Read existing chain — gRPC inputs first, HTTP body fallback.
	var chain []interface{}
	if c, ok := config["chain"].([]interface{}); ok {
		chain = c
	} else if body != nil {
		if c, ok := body["chain"].([]interface{}); ok {
			chain = c
		}
	}

	// Read origin — gRPC inputs first, HTTP body fallback.
	origin := "unknown"
	if o, ok := config["origin"].(string); ok && o != "" {
		origin = o
	} else if body != nil {
		if o, ok := body["origin"].(string); ok && o != "" {
			origin = o
		}
	}

	// Append this language's entry
	entry := map[string]interface{}{
		"language":  "go",
		"order":     len(chain) + 1,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	chain = append(chain, entry)

	// Store in context vars
	ctx.SetVar("chain", chain)

	return map[string]interface{}{
		"chain":  chain,
		"origin": origin,
	}, nil
}

// Ensure ChainTestNode implements NodeHandler
var _ blok.NodeHandler = (*ChainTestNode)(nil)
