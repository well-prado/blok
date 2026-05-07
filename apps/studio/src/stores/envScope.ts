import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * useEnvScope — Direction A · Phase 2.3.
 *
 * The "environment as first-class concept" part of the redesign. Today
 * Blok runs single-tenant per deployment so the backend doesn't filter
 * runs by environment yet (Phase 2.1 backend migration is pending).
 * This client-side slice lays the wiring so:
 *   - EnvChip in the sidebar can be a real dropdown
 *   - The current env name renders in chrome (sidebar, header)
 *   - When backend filtering lands, threading `?env=` into list
 *     endpoints is one branch in `lib/api.ts`, not a refactor
 *
 * Persisted to localStorage so refreshing the page doesn't drop the
 * operator back into "production" if they were inspecting "staging".
 *
 * Default env list is hardcoded for now — `production / staging / dev`.
 * Phase 2.1 will replace this with `useEnvironments()` reading from a
 * `/__blok/environments` endpoint that introspects from registered
 * deployments.
 */

export interface Environment {
	id: string;
	name: string;
	description?: string;
}

const DEFAULT_ENVIRONMENTS: Environment[] = [
	{ id: "production", name: "production", description: "live deployments" },
	{ id: "staging", name: "staging", description: "pre-prod" },
	{ id: "development", name: "development", description: "local + branch deploys" },
];

interface EnvScopeState {
	current: string;
	available: Environment[];
	setCurrent: (id: string) => void;
}

export const useEnvScope = create<EnvScopeState>()(
	persist(
		(set) => ({
			current: "production",
			available: DEFAULT_ENVIRONMENTS,
			setCurrent: (id) => set({ current: id }),
		}),
		{ name: "blok-studio:env-scope" },
	),
);

/** Convenience selector for components that just need the env name. */
export function useCurrentEnv(): Environment {
	// biome-ignore lint/style/noNonNullAssertion: DEFAULT_ENVIRONMENTS is statically non-empty and `available` is only ever assigned from it.
	return useEnvScope((s) => s.available.find((e) => e.id === s.current) ?? s.available[0]!);
}
