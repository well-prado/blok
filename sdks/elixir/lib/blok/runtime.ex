defmodule Blok.Runtime do
  @moduledoc "Protocol boundary for the supervised Elixir sidecar."

  alias Blok.Runtime.V1.{
    ExecuteResponse,
    HealthResponse,
    ListNodesResponse,
    Metrics,
    NodeError,
    NodeDescriptor,
    RuntimeState,
    TriggerInfo,
    WorkflowInfo
  }

  def execute(request) do
    node_name = request.node.name
    timeout_ms = request_deadline(request)
    metadata = telemetry_metadata(request)
    enqueued_at = System.monotonic_time()

    job = fn ->
      Logger.metadata(Enum.to_list(metadata))

      Blok.Telemetry.span(metadata, Blok.Telemetry.elapsed_ms(enqueued_at), fn ->
        execute_node(request)
      end)
    end

    case Blok.Admission.run(job, timeout_ms) do
      {:ok, %ExecuteResponse{} = response} ->
        response

      {:ok, {:error, error}} ->
        error_response(error, node_name)

      {:error, :overloaded} ->
        error_response(Blok.Error.overloaded(), node_name)

      {:error, :draining} ->
        error_response(
          %Blok.Error{
            code: "RUNTIME_DRAINING",
            category: "CANCELLED",
            message: "runtime is draining"
          },
          node_name
        )

      {:error, :deadline_exceeded} ->
        error_response(Blok.Error.timeout(), node_name)

      {:error, :execution_crashed} ->
        error_response(
          %Blok.Error{
            code: "NODE_PROCESS_CRASH",
            category: "INTERNAL",
            message: "node process crashed"
          },
          node_name
        )

      # A failure raised outside the node body (protocol decoding, telemetry
      # handler, logger metadata). It must still leave the endpoint standing.
      {:error, {kind, reason, _stacktrace}} ->
        error_response(
          %Blok.Error{
            code: "RUNTIME_#{String.upcase(to_string(kind))}",
            category: "INTERNAL",
            message: Blok.Logger.safe_inspect(reason)
          },
          node_name
        )
    end
  end

  def list_nodes do
    nodes =
      Enum.map(Blok.Registry.list(), fn module ->
        descriptor = Blok.Node.descriptor(module)

        %NodeDescriptor{
          name: descriptor.name,
          description: descriptor.description,
          input_schema_json: descriptor.input_schema_json,
          output_schema_json: descriptor.output_schema_json,
          capability_manifest_json: descriptor.capability_manifest_json,
          tags: descriptor.tags
        }
      end)

    %ListNodesResponse{
      nodes: nodes,
      sdk_name: "blok-elixir",
      sdk_version: Blok.version(),
      proto_version: "1.0.0",
      capabilities: if(Blok.Blob.enabled?(), do: [Blok.Blob.capability()], else: [])
    }
  end

  def health do
    snapshot = Blok.Admission.snapshot()

    %HealthResponse{
      status: if(snapshot.accepting, do: :SERVING, else: :NOT_SERVING),
      sdk_version: Blok.version(),
      registered_nodes: Enum.map(Blok.Registry.list(), & &1.__blok_node__().name)
    }
  end

  def started_event do
    %Blok.Runtime.V1.NodeStarted{
      at: %Google.Protobuf.Timestamp{seconds: System.system_time(:second)}
    }
  end

  defp execute_node(request) do
    node_name = request.node.name

    with {:ok, node} <- fetch_node(node_name),
         {:ok, input} <- decode_inputs(request.inputs),
         {:ok, context} <- context_from_request(request),
         result <- Blok.Node.run(node, context, input),
         {:ok, response} <- response_from_result(result, node_name) do
      response
    end
  end

  defp fetch_node(name) do
    case Blok.Registry.get(name) do
      nil ->
        {:error,
         %Blok.Error{
           code: "NODE_NOT_FOUND",
           category: "NOT_FOUND",
           message: "node '#{name}' is not registered"
         }}

      node ->
        {:ok, node}
    end
  end

  defp decode_inputs(bytes) do
    case Jason.decode(if(bytes in [nil, ""], do: "{}", else: bytes)) do
      {:ok, value} ->
        case Blok.Blob.resolve(value) do
          {:ok, resolved} ->
            {:ok, resolved}

          # A claim-check failure is not a JSON problem; say what actually broke.
          {:error, reason} ->
            {:error,
             Blok.Error.validation("claim-check inputs could not be resolved: #{reason}", %{
               reason: reason
             })}
        end

      {:error, reason} ->
        {:error, Blok.Error.validation("inputs are not valid JSON", %{reason: inspect(reason)})}
    end
  end

  defp context_from_request(request) do
    # Submessages are optional on the wire: a sparse request must project to an
    # empty context, never to a KeyError inside the execution.
    trigger = request.trigger || %TriggerInfo{}
    state = request.state || %RuntimeState{}
    workflow = request.workflow || %WorkflowInfo{}
    previous = decode_json(state.previous_output)
    vars = decode_json(state.vars) || %{}
    deadline_ms = request_deadline(request)
    token = Blok.Cancellation.new()

    {:ok,
     %Blok.Context{
       id: workflow.run_id || "",
       workflow_name: workflow.name || "",
       workflow_path: workflow.path || "",
       request: %{
         body: decode_json(trigger.body),
         headers: trigger.headers || %{},
         params: trigger.params || %{},
         query: trigger.query || %{},
         cookies: trigger.cookies || %{},
         method: trigger.method || "",
         url: trigger.url || "",
         base_url: trigger.base_url || ""
       },
       response: %{data: previous},
       vars: vars,
       env: state.env || %{},
       deadline_at: System.monotonic_time(:millisecond) + max(deadline_ms, 1),
       cancellation: token,
       logger_metadata: %{run_id: workflow.run_id || "", node: request.node.name}
     }}
  end

  defp response_from_result({:ok, data}, _node_name) do
    bytes = Jason.encode!(Blok.Schema.to_json(data))

    {:ok,
     %ExecuteResponse{
       success: true,
       data: bytes,
       content_type: "application/json",
       metrics: %Metrics{response_bytes: byte_size(bytes)}
     }}
  end

  defp response_from_result({:error, error}, node_name),
    do: {:ok, error_response(error, node_name)}

  defp error_response(error, node_name) do
    error = normalize_error(error)

    %ExecuteResponse{
      success: false,
      error: %NodeError{
        code: error.code,
        category: category(error.category),
        severity: :ERROR,
        node: node_name,
        sdk: "blok-elixir",
        sdk_version: Blok.version(),
        runtime_kind: "runtime.elixir",
        at: %Google.Protobuf.Timestamp{seconds: System.system_time(:second)},
        message: error.message,
        description: error.description || "",
        remediation: error.remediation || "",
        retryable: error.retryable,
        retry_after_ms: error.retry_after_ms || 0,
        details_json: Jason.encode!(error.details || %{})
      }
    }
  end

  defp normalize_error(%Blok.Error{} = error), do: error

  defp normalize_error(%Blok.Schema.ValidationError{issues: issues}),
    do: Blok.Error.validation("schema validation failed", %{issues: issues})

  defp normalize_error({kind, reason}),
    do: %Blok.Error{
      code: "NODE_#{String.upcase(to_string(kind))}",
      message: Blok.Logger.safe_inspect(reason)
    }

  defp normalize_error(error), do: %Blok.Error{message: Exception.message(error)}

  defp category("VALIDATION"), do: :VALIDATION
  defp category("CONFIGURATION"), do: :CONFIGURATION
  defp category("DEPENDENCY"), do: :DEPENDENCY
  defp category("TIMEOUT"), do: :TIMEOUT
  defp category("PERMISSION"), do: :PERMISSION
  defp category("RATE_LIMIT"), do: :RATE_LIMIT
  defp category("NOT_FOUND"), do: :NOT_FOUND
  defp category("CONFLICT"), do: :CONFLICT
  defp category("CANCELLED"), do: :CANCELLED
  defp category("INTERNAL"), do: :INTERNAL
  defp category("PROTOCOL"), do: :PROTOCOL
  defp category("DATA"), do: :DATA
  defp category(_), do: :INTERNAL

  # Identity only. Inputs, env, headers, and output never reach telemetry
  # handlers or Logger metadata.
  defp telemetry_metadata(request) do
    workflow = request.workflow || %WorkflowInfo{}

    %{node: request.node.name, run_id: workflow.run_id || "", workflow: workflow.name || ""}
  end

  defp request_deadline(request) do
    case request.options && request.options.deadline_ms do
      value when is_integer(value) and value > 0 -> value
      _ -> 30_000
    end
  end

  defp decode_json(nil), do: nil
  defp decode_json(""), do: nil
  defp decode_json(bytes) when is_binary(bytes), do: Jason.decode!(bytes)
  defp decode_json(value), do: value
end
