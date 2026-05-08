using Blok.Core.Config;
using Blok.Core.Node;
using Blok.Core.Nodes;
using Blok.Core.Server;

var config = ServerConfig.FromEnv();

// Create registry and register nodes
var registry = new NodeRegistry(config.Version);
registry.Register("hello-world", new HelloWorldNode());
registry.Register("api-call", new ApiCallNode());
registry.Register("transform-data", new TransformDataNode());
registry.Register("chain-test", new ChainTestNode());
registry.Register("blok-error-demo", new BlokErrorDemoNode());

Console.WriteLine($"Blok C# Runtime v{config.Version}");
Console.WriteLine($"  Registered {registry.Count} node(s): [{string.Join(", ", registry.NodeNames())}]");

// Start the runtime server
await RuntimeServer.Run(registry, config);
