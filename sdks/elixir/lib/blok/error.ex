defmodule Blok.Error do
  defexception code: "NODE_ERROR",
               category: "INTERNAL",
               severity: "ERROR",
               message: "node failed",
               description: "",
               remediation: "",
               retryable: false,
               retry_after_ms: 0,
               details: %{},
               causes: []

  def validation(message, details \\ %{}),
    do: %__MODULE__{
      code: "NODE_INPUT_VALIDATION",
      category: "VALIDATION",
      message: message,
      details: details
    }

  def cancelled(message \\ "node execution was cancelled"),
    do: %__MODULE__{code: "NODE_CANCELLED", category: "CANCELLED", message: message}

  def timeout(message \\ "node execution exceeded its deadline"),
    do: %__MODULE__{
      code: "NODE_DEADLINE_EXCEEDED",
      category: "TIMEOUT",
      message: message,
      retryable: true
    }

  def overloaded,
    do: %__MODULE__{
      code: "RUNTIME_OVERLOADED",
      category: "RATE_LIMIT",
      message: "runtime admission queue is full",
      retryable: true,
      retry_after_ms: 100
    }
end
