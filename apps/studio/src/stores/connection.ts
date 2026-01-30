import { create } from "zustand";

interface ConnectionState {
  status: "connecting" | "connected" | "disconnected" | "error";
  activeStreams: number;
  setStatus: (status: ConnectionState["status"]) => void;
  incrementStreams: () => void;
  decrementStreams: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  activeStreams: 0,
  setStatus: (status) => set({ status }),
  incrementStreams: () => set((s) => ({ activeStreams: s.activeStreams + 1 })),
  decrementStreams: () => set((s) => ({ activeStreams: Math.max(0, s.activeStreams - 1) })),
}));
