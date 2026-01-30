import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectGlobalStream } from "@/lib/sse";
import { useConnectionStore } from "@/stores/connection";
import type { RunEvent } from "@/types";

/**
 * Subscribe to the global SSE stream for live dashboard updates.
 * Invalidates relevant queries when events arrive.
 */
export function useGlobalStream(enabled = true) {
  const queryClient = useQueryClient();
  const { setStatus, incrementStreams, decrementStreams } = useConnectionStore();

  useEffect(() => {
    if (!enabled) return;

    incrementStreams();
    setStatus("connecting");

    const disconnect = connectGlobalStream({
      onEvent: (_event: RunEvent) => {
        // Invalidate workflow and run queries to trigger refetch
        queryClient.invalidateQueries({ queryKey: ["workflows"] });
        queryClient.invalidateQueries({ queryKey: ["runs"] });
      },
      onOpen: () => setStatus("connected"),
      onError: () => setStatus("error"),
    });

    return () => {
      disconnect();
      decrementStreams();
    };
  }, [enabled, queryClient, setStatus, incrementStreams, decrementStreams]);
}
