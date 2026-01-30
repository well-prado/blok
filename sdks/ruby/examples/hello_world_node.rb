# frozen_string_literal: true

require_relative "../lib/blok"

# HelloWorldNode greets the user with a configurable prefix.
#
# Config:
#   - "prefix" (string, optional): Greeting prefix (default: "Hello")
#
# Request body:
#   - "name" (string, optional): Name to greet (default: "World")
#
# Output:
#   { "message" => "Hello, World!", "timestamp" => "...", "language" => "ruby" }
class HelloWorldNode < Blok::Node::NodeHandler
  def execute(ctx, config)
    name   = ctx.request.body_str("name") || "World"
    prefix = config["prefix"] || "Hello"

    message = "#{prefix}, #{name}!"

    # Store the greeting in context for downstream nodes
    ctx.set_var("greeting", message)

    {
      "message"   => message,
      "timestamp" => Time.now.utc.iso8601,
      "language"  => "ruby"
    }
  end
end

# ----- Boot the server if run directly -----
if __FILE__ == $PROGRAM_NAME
  registry = Blok::Server::RuntimeApp.registry
  registry.register("hello-world", HelloWorldNode.new)

  puts "Starting HelloWorldNode on port 8080..."
  Blok::Server::RuntimeApp.run!(port: 8080, bind: "0.0.0.0")
end
