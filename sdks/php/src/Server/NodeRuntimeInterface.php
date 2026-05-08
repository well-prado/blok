<?php

declare(strict_types=1);

namespace Blok\Blok\Server;

use Blok\Runtime\V1\ExecuteRequest;
use Blok\Runtime\V1\ExecuteResponse;
use Blok\Runtime\V1\HealthRequest;
use Blok\Runtime\V1\HealthResponse;
use Blok\Runtime\V1\ListNodesRequest;
use Blok\Runtime\V1\ListNodesResponse;
use Spiral\RoadRunner\GRPC\ContextInterface;
use Spiral\RoadRunner\GRPC\ServiceInterface;

/**
 * Spiral/RoadRunner-style service interface for the canonical
 * `blok.runtime.v1.NodeRuntime` contract.
 *
 * The grpc_php_plugin protoc plugin only generates client stubs for ext-grpc;
 * it does not emit server-side interfaces in the spiral convention (with the
 * NAME constant + unary method signatures). This file is the hand-written
 * equivalent that spiral/roadrunner-grpc consumes via reflection.
 *
 * ExecuteStream is intentionally omitted: it is a server-streaming RPC, which
 * spiral/roadrunner-grpc does not currently dispatch. The RoadRunner daemon
 * will return UNIMPLEMENTED at the gRPC layer when streaming is requested.
 * Phase 5 of the migration will revisit streaming.
 */
interface NodeRuntimeInterface extends ServiceInterface
{
    /** Fully-qualified gRPC service name; used by spiral as the registry key. */
    public const NAME = 'blok.runtime.v1.NodeRuntime';

    public function Execute(ContextInterface $ctx, ExecuteRequest $in): ExecuteResponse;

    public function Health(ContextInterface $ctx, HealthRequest $in): HealthResponse;

    public function ListNodes(ContextInterface $ctx, ListNodesRequest $in): ListNodesResponse;
}
