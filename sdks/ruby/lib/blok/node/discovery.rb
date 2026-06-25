# frozen_string_literal: true

require_relative "node_handler"

module Blok
  module Node
    # Discover + register user-authored node handlers from a directory.
    #
    # Each user node lives in `<nodes_dir>/<name>/node.rb` and defines a class
    # `class <Pascal>Node < Blok::Node::NodeHandler` (or `< TypedNode`). We
    # `require` each file, then register only the NodeHandler subclasses defined
    # during THIS call — the same before/after snapshot the Python SDK uses
    # (`_DECORATED_NODES[before:]`). Purely additive, so the SDK's built-in nodes
    # (registered earlier in serve.rb) are untouched.
    #
    # Node name resolution (explicit, deterministic — no ObjectSpace scan):
    #   1. `klass.node_name` when the class declares one (TypedNode authors), else
    #   2. the class name with a trailing "Node" dropped, demodulized + kebab-cased:
    #      `GreetUser` -> "greet-user", `FooNode` -> "foo".
    #
    # Returns the number of newly registered nodes. A file that fails to require
    # is logged to stderr and skipped so one bad node can't sink the runtime.
    #
    # @param registry [NodeRegistry] the registry to populate
    # @param nodes_dir [String, nil] BLOK_NODES_DIR (project's runtimes/ruby/nodes)
    # @return [Integer] count of newly registered user nodes
    def self.load_user_nodes(registry, nodes_dir)
      return 0 if nodes_dir.nil? || nodes_dir.empty? || !File.directory?(nodes_dir)

      before = NodeHandler::DESCENDANTS.length

      Dir.children(nodes_dir).sort.each do |entry|
        node_file = File.join(nodes_dir, entry, "node.rb")
        next unless File.file?(node_file)

        begin
          require File.expand_path(node_file)
        rescue StandardError, LoadError, SyntaxError => e
          warn "[blok][discovery] failed to load #{node_file}: #{e.class}: #{e.message}"
        end
      end

      new_classes = NodeHandler::DESCENDANTS[before..] || []
      new_classes.each do |klass|
        registry.register(node_name_for(klass), klass.new)
      end
      new_classes.length
    end

    # Resolve the registration name for a discovered handler class.
    def self.node_name_for(klass)
      declared = klass.respond_to?(:node_name) ? klass.node_name : nil
      return declared.to_s unless declared.nil? || declared.to_s.empty?

      base = klass.name.to_s.split("::").last.to_s.sub(/Node\z/, "")
      base.gsub(/([a-z\d])([A-Z])/, '\1-\2').downcase
    end
  end
end
