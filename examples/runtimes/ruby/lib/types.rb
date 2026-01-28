# frozen_string_literal: true

module Blok
  # Request represents the incoming HTTP request data
  class Request
    attr_accessor :body, :headers, :params, :query, :method, :url, :cookies, :base_url

    def initialize(body: nil, headers: {}, params: {}, query: {}, method: nil, url: nil, cookies: {}, base_url: nil)
      @body     = body
      @headers  = headers
      @params   = params
      @query    = query
      @method   = method
      @url      = url
      @cookies  = cookies
      @base_url = base_url
    end

    def self.from_hash(hash)
      return new if hash.nil?

      new(
        body:     hash["body"],
        headers:  hash["headers"] || {},
        params:   hash["params"] || {},
        query:    hash["query"] || {},
        method:   hash["method"],
        url:      hash["url"],
        cookies:  hash["cookies"] || {},
        base_url: hash["baseUrl"]
      )
    end

    def to_hash
      {
        "body"     => body,
        "headers"  => headers,
        "params"   => params,
        "query"    => query,
        "method"   => method,
        "url"      => url,
        "cookies"  => cookies,
        "baseUrl"  => base_url
      }
    end
  end

  # Response represents the workflow response
  class Response
    attr_accessor :data, :content_type, :success, :error

    def initialize(data: nil, content_type: nil, success: true, error: nil)
      @data         = data
      @content_type = content_type
      @success      = success
      @error        = error
    end

    def self.from_hash(hash)
      return new if hash.nil?

      new(
        data:         hash["data"],
        content_type: hash["contentType"],
        success:      hash.fetch("success", true),
        error:        hash["error"]
      )
    end

    def to_hash
      {
        "data"        => data,
        "contentType" => content_type,
        "success"     => success,
        "error"       => error
      }
    end
  end

  # Context represents the workflow execution context
  class Context
    attr_accessor :id, :workflow_name, :workflow_path, :request, :response, :vars, :env

    def initialize(id: nil, workflow_name: nil, workflow_path: nil, request: nil, response: nil, vars: {}, env: {})
      @id            = id
      @workflow_name = workflow_name
      @workflow_path = workflow_path
      @request       = request || Request.new
      @response      = response || Response.new
      @vars          = vars
      @env           = env
    end

    def self.from_hash(hash)
      return new if hash.nil?

      new(
        id:            hash["id"],
        workflow_name: hash["workflow_name"],
        workflow_path: hash["workflow_path"],
        request:       Request.from_hash(hash["request"]),
        response:      Response.from_hash(hash["response"]),
        vars:          hash["vars"] || {},
        env:           hash["env"] || {}
      )
    end

    def to_hash
      {
        "id"            => id,
        "workflow_name" => workflow_name,
        "workflow_path" => workflow_path,
        "request"       => request.to_hash,
        "response"      => response.to_hash,
        "vars"          => vars,
        "env"           => env
      }
    end
  end

  # NodeConfig represents node-specific configuration
  class NodeConfig
    attr_accessor :name, :path, :config

    def initialize(name: nil, path: nil, config: {})
      @name   = name
      @path   = path
      @config = config
    end

    def self.from_hash(hash)
      return new if hash.nil?

      new(
        name:   hash["name"],
        path:   hash["path"],
        config: hash["config"] || {}
      )
    end

    def to_hash
      {
        "name"   => name,
        "path"   => path,
        "config" => config
      }
    end
  end

  # ExecutionRequest is the request received from the Blok runner
  class ExecutionRequest
    attr_accessor :node, :context

    def initialize(node: nil, context: nil)
      @node    = node || NodeConfig.new
      @context = context || Context.new
    end

    def self.from_hash(hash)
      return new if hash.nil?

      new(
        node:    NodeConfig.from_hash(hash["node"]),
        context: Context.from_hash(hash["context"])
      )
    end

    def to_hash
      {
        "node"    => node.to_hash,
        "context" => context.to_hash
      }
    end
  end

  # ExecutionResult is the response returned to the Blok runner
  class ExecutionResult
    attr_accessor :success, :data, :errors, :logs, :metrics

    def initialize(success: true, data: nil, errors: nil, logs: [], metrics: {})
      @success = success
      @data    = data
      @errors  = errors
      @logs    = logs
      @metrics = metrics
    end

    def to_hash
      hash = {
        "success" => success,
        "data"    => data,
        "errors"  => errors
      }
      hash["logs"]    = logs    unless logs.empty?
      hash["metrics"] = metrics unless metrics.empty?
      hash
    end
  end

  # ExecutionMetrics holds timing and performance data for a node execution
  class ExecutionMetrics
    attr_accessor :duration_ms, :started_at, :finished_at

    def initialize(duration_ms: 0, started_at: nil, finished_at: nil)
      @duration_ms = duration_ms
      @started_at  = started_at
      @finished_at = finished_at
    end

    def to_hash
      {
        "duration_ms" => duration_ms,
        "started_at"  => started_at,
        "finished_at" => finished_at
      }
    end
  end

  # HealthStatus represents the health status of the runtime
  class HealthStatus
    attr_accessor :status, :version, :nodes_loaded

    def initialize(status: "healthy", version: "1.0.0", nodes_loaded: [])
      @status       = status
      @version      = version
      @nodes_loaded = nodes_loaded
    end

    def to_hash
      {
        "status"       => status,
        "version"      => version,
        "nodes_loaded" => nodes_loaded
      }
    end
  end
end
