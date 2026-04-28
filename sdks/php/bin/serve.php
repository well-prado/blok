<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Blok\Blok\Config\ServerConfig;
use Blok\Blok\Config\Transport;
use Blok\Blok\Examples\ApiCallNode;
use Blok\Blok\Examples\ChainTestNode;
use Blok\Blok\Examples\HelloWorldNode;
use Blok\Blok\Examples\TransformDataNode;
use Blok\Blok\Node\NodeRegistry;
use Blok\Blok\Server\BlokNodeRuntimeService;
use Blok\Blok\Server\NodeRuntimeInterface;
use Blok\Blok\Server\Server;
use Spiral\RoadRunner\GRPC\Server as GrpcServer;

$config = ServerConfig::fromEnv();

$registry = new NodeRegistry($config->version);
$registry->register('hello-world', new HelloWorldNode());
$registry->register('api-call', new ApiCallNode());
$registry->register('transform-data', new TransformDataNode());
$registry->register('chain-test', new ChainTestNode());

fwrite(
    STDERR,
    sprintf("Registered %d nodes: %s\n", $registry->count(), implode(', ', $registry->nodeNames())),
);

switch ($config->transport) {
    case Transport::Grpc:
        // Worker mode: the RoadRunner daemon (started via `rr serve -c .rr.yaml`)
        // handles HTTP/2 + gRPC framing in Go and dispatches each call to this
        // PHP worker over goridge pipes. Server::serve() blocks reading payloads
        // from stdin until rr signals shutdown.
        $service = new BlokNodeRuntimeService($registry, sdkVersion: $config->version);
        $server = new GrpcServer();
        $server->registerService(NodeRuntimeInterface::class, $service);
        fwrite(STDERR, "Blok PHP gRPC worker entering spiral/roadrunner-grpc loop\n");
        $server->serve();
        break;

    case Transport::Both:
        // PHP cannot run two transports in one process without OS threads.
        // Operators run `rr serve` (gRPC) and `php bin/serve.php` (HTTP) side
        // by side; here we fall through to HTTP so this command still serves
        // half the matrix on its own.
        fwrite(STDERR, "BLOK_TRANSPORT=both: this process serves HTTP only; run `rr serve -c .rr.yaml` separately for gRPC\n");
        // intentional fallthrough
    case Transport::Http:
    default:
        $server = new Server($registry, $config);
        $server->start();
        break;
}
