<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Blok\Blok\Config\ServerConfig;
use Blok\Blok\Examples\ApiCallNode;
use Blok\Blok\Examples\ChainTestNode;
use Blok\Blok\Examples\HelloWorldNode;
use Blok\Blok\Examples\TransformDataNode;
use Blok\Blok\Node\NodeRegistry;
use Blok\Blok\Server\Server;

// Load configuration from environment
$config = ServerConfig::fromEnv();

// Create registry and register example nodes
$registry = new NodeRegistry($config->version);
$registry->register('hello-world', new HelloWorldNode());
$registry->register('api-call', new ApiCallNode());
$registry->register('transform-data', new TransformDataNode());
$registry->register('chain-test', new ChainTestNode());

echo sprintf("Registered %d nodes: %s\n", $registry->count(), implode(', ', $registry->nodeNames()));

// Start the server
$server = new Server($registry, $config);
$server->start();
