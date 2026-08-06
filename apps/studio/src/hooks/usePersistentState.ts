import { useState } from "react";

/**
 * useState backed by localStorage — "the user's choice" for UI toggles that
 * have no server-side profile to live in (Studio has none). Lazily reads on
 * mount and writes through the setter, both guarded by try/catch: private
 * browsing / disabled storage must degrade to `defaultValue`, not throw.
 *
 * `serialize`/`deserialize` default to identity, i.e. this works out of the
 * box for `usePersistentState<string>`. Callers persisting other shapes
 * (booleans, enums, JSON) supply their own — see `WorkflowGraph.tsx`'s
 * `"1"`/`"0"` flag encoding.
 */
export function usePersistentState<T>(
	key: string,
	defaultValue: T,
	serialize: (value: T) => string = (value) => value as unknown as string,
	deserialize: (raw: string) => T = (raw) => raw as unknown as T,
): [T, (value: T | ((current: T) => T)) => void] {
	const [state, setState] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? defaultValue : deserialize(raw);
		} catch {
			return defaultValue;
		}
	});

	const setPersistent = (value: T | ((current: T) => T)) => {
		setState((current) => {
			const next = typeof value === "function" ? (value as (current: T) => T)(current) : value;
			try {
				localStorage.setItem(key, serialize(next));
			} catch {
				// ponytail: private mode / storage disabled — in-memory state still works, just doesn't survive reload.
			}
			return next;
		});
	};

	return [state, setPersistent];
}
