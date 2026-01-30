# frozen_string_literal: true

require_relative "../lib/blok"
require "net/http"
require "uri"
require "json"

# ApiCallNode makes HTTP requests to external APIs.
#
# Config:
#   - "url"     (string, required): The URL to call
#   - "method"  (string, optional): HTTP method (default: "GET")
#   - "timeout" (integer, optional): Timeout in seconds (default: 10)
#   - "headers" (hash, optional): Additional request headers
#
# Request body:
#   - "body" (object, optional): Request body for POST/PUT/PATCH
#
# Output:
#   { "status" => 200, "data" => {...}, "headers" => {...} }
class ApiCallNode < Blok::Node::NodeHandler
  def execute(ctx, config)
    url = config["url"]
    unless url
      raise Blok::Errors::NodeError.configuration("'url' is required in node config")
    end

    method  = (config["method"] || "GET").upcase
    timeout = config["timeout"] || 10

    uri = URI.parse(url)

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl     = uri.scheme == "https"
    http.open_timeout = timeout
    http.read_timeout = timeout

    request = build_request(method, uri, ctx, config)

    begin
      response = http.request(request)
    rescue StandardError => e
      raise Blok::Errors::NodeError.network("request to #{url} failed: #{e.message}")
    end

    body = begin
      JSON.parse(response.body)
    rescue JSON::ParserError
      response.body
    end

    headers = {}
    response.each_header { |k, v| headers[k] = v }

    {
      "status"  => response.code.to_i,
      "data"    => body,
      "headers" => headers
    }
  end

  private

  def build_request(method, uri, ctx, config)
    klass = case method
            when "POST"   then Net::HTTP::Post
            when "PUT"    then Net::HTTP::Put
            when "PATCH"  then Net::HTTP::Patch
            when "DELETE" then Net::HTTP::Delete
            when "HEAD"   then Net::HTTP::Head
            else               Net::HTTP::Get
            end

    req = klass.new(uri)
    req["Content-Type"] = "application/json"

    # Add configured headers
    if config["headers"].is_a?(Hash)
      config["headers"].each { |k, v| req[k] = v.to_s }
    end

    # Attach body for POST/PUT/PATCH
    if %w[POST PUT PATCH].include?(method) && ctx.request.body.is_a?(Hash)
      body_data = ctx.request.body["body"]
      req.body = JSON.generate(body_data) if body_data
    end

    req
  end
end

# ----- Boot the server if run directly -----
if __FILE__ == $PROGRAM_NAME
  registry = Blok::Server::RuntimeApp.registry
  registry.register("api-call", ApiCallNode.new)

  puts "Starting ApiCallNode on port 8080..."
  Blok::Server::RuntimeApp.run!(port: 8080, bind: "0.0.0.0")
end
