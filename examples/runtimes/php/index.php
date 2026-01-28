<?php

declare(strict_types=1);

/**
 * Blok PHP Runtime - Entry Point
 *
 * Bootstraps the HTTP server, registers all available nodes,
 * and starts listening for execution requests from the Blok runner.
 */

require __DIR__ . '/vendor/autoload.php';

use Blok\NodeRegistry;
use Blok\Nodes\HelloWorldNode;
use Blok\Server;

// Initialize node registry
$registry = new NodeRegistry();

// Register nodes
$registry->register('hello-world', new HelloWorldNode());
// Add more nodes here as needed:
// $registry->register('another-node', new AnotherNode());

// Create and start the server
$server = new Server($registry);
$server->start();
