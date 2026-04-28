<?php
// GENERATED CODE -- DO NOT EDIT!

// Original file comments:
// Blok Runtime v1 — the wire contract between the TypeScript runner and SDK
// servers (Python, Go, Rust, Java, C#, PHP, Ruby).
//
// Single source of truth for cross-language interop. Generated stubs in each
// SDK are derived from this file via `make proto`.
//
// Stability: `blok.runtime.v1` is additive-only. CI runs `buf breaking` to
// reject backward-incompatible changes. Breaking changes go to `v2`, served
// alongside `v1` during migration.
//
namespace Blok\Runtime\V1;

/**
 * =============================================================================
 * Service
 * =============================================================================
 *
 * NodeRuntime is the contract every Blok SDK exposes. One service handles
 * three responsibilities:
 *   1. Run a node (Execute / ExecuteStream)
 *   2. Tell the runner which nodes it can run (ListNodes)
 *   3. Tell the runner if it is alive (Health)
 */
class NodeRuntimeClient extends \Grpc\BaseStub {

    /**
     * @param string $hostname hostname
     * @param array $opts channel options
     * @param \Grpc\Channel $channel (optional) re-use channel object
     */
    public function __construct($hostname, $opts, $channel = null) {
        parent::__construct($hostname, $opts, $channel);
    }

    /**
     * Run a node and return its result. Unary, deadline-driven.
     * @param \Blok\Runtime\V1\ExecuteRequest $argument input argument
     * @param array $metadata metadata
     * @param array $options call options
     * @return \Grpc\UnaryCall<\Blok\Runtime\V1\ExecuteResponse>
     */
    public function Execute(\Blok\Runtime\V1\ExecuteRequest $argument,
      $metadata = [], $options = []) {
        return $this->_simpleRequest('/blok.runtime.v1.NodeRuntime/Execute',
        $argument,
        ['\Blok\Runtime\V1\ExecuteResponse', 'decode'],
        $metadata, $options);
    }

    /**
     * Run a node and stream events back as it executes (logs, progress, partial
     * results, then a final ExecuteResponse). Optional capability — SDKs that
     * don't implement it should return UNIMPLEMENTED.
     * @param \Blok\Runtime\V1\ExecuteRequest $argument input argument
     * @param array $metadata metadata
     * @param array $options call options
     * @return \Grpc\ServerStreamingCall
     */
    public function ExecuteStream(\Blok\Runtime\V1\ExecuteRequest $argument,
      $metadata = [], $options = []) {
        return $this->_serverStreamRequest('/blok.runtime.v1.NodeRuntime/ExecuteStream',
        $argument,
        ['\Blok\Runtime\V1\ExecuteEvent', 'decode'],
        $metadata, $options);
    }

    /**
     * Health check (wire-compatible with grpc.health.v1.Health/Check).
     * @param \Blok\Runtime\V1\HealthRequest $argument input argument
     * @param array $metadata metadata
     * @param array $options call options
     * @return \Grpc\UnaryCall<\Blok\Runtime\V1\HealthResponse>
     */
    public function Health(\Blok\Runtime\V1\HealthRequest $argument,
      $metadata = [], $options = []) {
        return $this->_simpleRequest('/blok.runtime.v1.NodeRuntime/Health',
        $argument,
        ['\Blok\Runtime\V1\HealthResponse', 'decode'],
        $metadata, $options);
    }

    /**
     * Discover registered nodes and their schemas (drives Studio + OpenAPI gen).
     * @param \Blok\Runtime\V1\ListNodesRequest $argument input argument
     * @param array $metadata metadata
     * @param array $options call options
     * @return \Grpc\UnaryCall<\Blok\Runtime\V1\ListNodesResponse>
     */
    public function ListNodes(\Blok\Runtime\V1\ListNodesRequest $argument,
      $metadata = [], $options = []) {
        return $this->_simpleRequest('/blok.runtime.v1.NodeRuntime/ListNodes',
        $argument,
        ['\Blok\Runtime\V1\ListNodesResponse', 'decode'],
        $metadata, $options);
    }

}
