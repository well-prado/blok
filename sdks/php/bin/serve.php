<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Blok\Nanoservice\Config\ServerConfig;
use Blok\Nanoservice\Examples\ApiCallNode;
use Blok\Nanoservice\Examples\HelloWorldNode;
use Blok\Nanoservice\Examples\TransformDataNode;
use Blok\Nanoservice\Node\NodeRegistry;
use Blok\Nanoservice\Server\Server;

// Load configuration from environment
$config = ServerConfig::fromEnv();

// Create registry and register example nodes
$registry = new NodeRegistry($config->version);
$registry->register('hello-world', new HelloWorldNode());
$registry->register('api-call', new ApiCallNode());
$registry->register('transform-data', new TransformDataNode());

echo sprintf("Registered %d nodes: %s\n", $registry->count(), implode(', ', $registry->nodeNames()));

// Start the server
$server = new Server($registry, $config);
$server->start();
