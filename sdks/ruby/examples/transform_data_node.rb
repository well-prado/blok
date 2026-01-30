# frozen_string_literal: true

require_relative "../lib/blok"

# TransformDataNode transforms JSON data based on field mappings.
#
# Config:
#   - "mappings"     (hash, optional): Map of target field -> source field path (dot-notation)
#   - "include_only" (array, optional): Only include these fields in output
#   - "exclude"      (array, optional): Exclude these fields from output
#   - "defaults"     (hash, optional): Default values for missing fields
#
# Input: Request body (must be a JSON object)
# Output: Transformed JSON object
class TransformDataNode < Blok::Node::NodeHandler
  def execute(ctx, config)
    body = ctx.request.body
    unless body.is_a?(Hash)
      raise Blok::Errors::NodeError.validation("request body must be a JSON object")
    end

    result = {}

    # Apply field mappings if configured
    if config["mappings"].is_a?(Hash)
      config["mappings"].each do |target, source_path|
        next unless source_path.is_a?(String)

        value = get_nested_value(body, source_path)
        result[target] = value unless value.nil?
      end
    else
      # No mappings -- copy all fields
      body.each { |k, v| result[k] = v }
    end

    # Apply include_only filter
    if config["include_only"].is_a?(Array)
      allowed = config["include_only"]
      result.select! { |k, _| allowed.include?(k) }
    end

    # Apply exclude filter
    if config["exclude"].is_a?(Array)
      config["exclude"].each { |field| result.delete(field) }
    end

    # Apply defaults for missing fields
    if config["defaults"].is_a?(Hash)
      config["defaults"].each do |k, v|
        result[k] = v unless result.key?(k)
      end
    end

    # Store in context for downstream nodes
    ctx.set_var("transformed_data", result)

    result
  end

  private

  # Traverse dot-notation path (e.g. "user.name") into nested hashes.
  def get_nested_value(data, path)
    current = data
    path.split(".").each do |part|
      return nil unless current.is_a?(Hash)

      current = current[part]
    end
    current
  end
end

# ----- Boot the server if run directly -----
if __FILE__ == $PROGRAM_NAME
  registry = Blok::Server::RuntimeApp.registry
  registry.register("transform-data", TransformDataNode.new)

  puts "Starting TransformDataNode on port 8080..."
  Blok::Server::RuntimeApp.run!(port: 8080, bind: "0.0.0.0")
end
