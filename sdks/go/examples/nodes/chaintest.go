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
func (n *ChainTestNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	body := ctx.Request.BodyMap()

	// Read existing chain (default to empty slice)
	var chain []interface{}
	if body != nil {
		if c, ok := body["chain"].([]interface{}); ok {
			chain = c
		}
	}

	// Read origin
	origin := "unknown"
	if body != nil {
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
