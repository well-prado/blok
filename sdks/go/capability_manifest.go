package blok

import "encoding/json"

// CapabilityManifest is the language-neutral v1 operational contract from ADR 0003.
// Secret entries are opaque reference names, never credential values.
type CapabilityManifest struct {
	Version        string                    `json:"version"`
	Classification string                    `json:"classification"`
	Effects        []string                  `json:"effects"`
	Capabilities   []string                  `json:"capabilities"`
	Secrets        []string                  `json:"secrets"`
	Determinism    string                    `json:"determinism"`
	Idempotency    string                    `json:"idempotency"`
	Maturity       string                    `json:"maturity"`
	Resources      *CapabilityResourceBounds `json:"resources,omitempty"`
	Runtimes       []string                  `json:"runtimes,omitempty"`
	Triggers       []string                  `json:"triggers,omitempty"`
}

type CapabilityResourceBounds struct {
	MaxDurationMs  int64 `json:"maxDurationMs,omitempty"`
	MaxMemoryBytes int64 `json:"maxMemoryBytes,omitempty"`
	MaxInputBytes  int64 `json:"maxInputBytes,omitempty"`
	MaxOutputBytes int64 `json:"maxOutputBytes,omitempty"`
	MaxConcurrency int64 `json:"maxConcurrency,omitempty"`
}

// JSON returns the manifest's wire representation for gRPC ListNodes.
func (m CapabilityManifest) JSON() []byte {
	b, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return b
}
