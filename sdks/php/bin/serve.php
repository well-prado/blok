<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Blok\Blok\Config\ServerConfig;
use Blok\Blok\Config\Transport;
use Blok\Blok\Examples\ApiCallNode;
use Blok\Blok\Examples\BlokErrorDemoNode;
use Blok\Blok\Examples\ChainTestNode;
use Blok\Blok\Examples\HelloWorldNode;
use Blok\Blok\Examples\TransformDataNode;
use Blok\Blok\Examples\TypedGreetNode;
use Blok\Blok\Node\NodeHandler;
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
$registry->register('blok-error-demo', new BlokErrorDemoNode());
$registry->register('typed-greet', new TypedGreetNode());

// Discover user nodes scaffolded under runtimes/php/nodes/ (mirrors Python's
// BLOK_NODES_DIR scan). The CLI sets BLOK_NODES_DIR; each node lives at
// <dir>/<name>/src/Nodes/<Pascal>Node.php with class
// Blok\Blok\Nodes\<Pascal>\<Pascal>Node implementing NodeHandler, registered
// under its directory name. require_once is enough — nodes use the SDK's
// already-autoloaded classes, so no composer-autoloader merge is needed.
$nodesDir = getenv('BLOK_NODES_DIR') ?: '';
if ($nodesDir !== '' && is_dir($nodesDir)) {
    $discovered = 0;
    foreach (glob($nodesDir . '/*/src/Nodes/*Node.php') ?: [] as $file) {
        // ponytail: name = the node's top dir; convention class lives under it.
        $name = basename(dirname($file, 3));
        $pascal = str_replace(' ', '', ucwords(str_replace(['-', '_'], ' ', $name)));
        $class = "Blok\\Blok\\Nodes\\{$pascal}\\{$pascal}Node";

        require_once $file;
        if (!class_exists($class)) {
            fwrite(STDERR, sprintf("[blok] skipping user node '%s': class %s not found\n", $name, $class));
            continue;
        }
        $handler = new $class();
        if (!$handler instanceof NodeHandler) {
            fwrite(STDERR, sprintf("[blok] skipping user node '%s': %s does not implement NodeHandler\n", $name, $class));
            continue;
        }
        $registry->register($name, $handler);
        $discovered++;
    }
    if ($discovered > 0) {
        fwrite(STDERR, sprintf("Discovered %d user node(s) from %s\n", $discovered, $nodesDir));
    }
}

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
