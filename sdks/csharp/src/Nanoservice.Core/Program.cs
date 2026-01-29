using Nanoservice.Core.Config;
using Nanoservice.Core.Node;
using Nanoservice.Core.Nodes;
using Nanoservice.Core.Server;

var config = ServerConfig.FromEnv();

// Create registry and register nodes
var registry = new NodeRegistry(config.Version);
registry.Register("hello-world", new HelloWorldNode());
registry.Register("api-call", new ApiCallNode());
registry.Register("transform-data", new TransformDataNode());

Console.WriteLine($"Nanoservice C# Runtime v{config.Version}");
Console.WriteLine($"  Registered {registry.Count} node(s): [{string.Join(", ", registry.NodeNames())}]");

// Start the runtime server
await RuntimeServer.Run(registry, config);
