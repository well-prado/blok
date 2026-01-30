import type { RunEvent } from "@/types";
import { create } from "zustand";

interface LiveFeedState {
	events: RunEvent[];
	maxEvents: number;
	pushEvent: (event: RunEvent) => void;
}

export const useLiveFeedStore = create<LiveFeedState>((set) => ({
	events: [],
	maxEvents: 50,
	pushEvent: (event) =>
		set((state) => {
			const next = [event, ...state.events];
			return { events: next.length > state.maxEvents ? next.slice(0, state.maxEvents) : next };
		}),
}));
