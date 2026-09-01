import { useCallback, useEffect, useId, useRef } from "react";
import { parseSequence, useShortcutContext } from "../components/providers/ShortcutProvider";

export interface ShortcutOptions {
	description?: string;
	ignoreFocus?: boolean;
}

export const useShortcut = (keyCombo: string, callback: (e: KeyboardEvent) => void, options?: ShortcutOptions) => {
	const { registerShortcut, unregisterShortcut } = useShortcutContext();
	const id = useId();
	const callbackRef = useRef(callback);
	callbackRef.current = callback;

	// Callers normally pass an inline callback. Registering that function
	// directly makes the effect run after every provider update: registration
	// updates activeShortcuts, which re-renders the caller, which registers
	// again. Keep one dispatcher registered and forward to the latest callback.
	const dispatch = useCallback((event: KeyboardEvent) => callbackRef.current(event), []);
	const description = options?.description;
	const ignoreFocus = options?.ignoreFocus;

	useEffect(() => {
		registerShortcut({
			id,
			keyCombo,
			parsedSequence: parseSequence(keyCombo),
			options: description === undefined && ignoreFocus === undefined ? undefined : { description, ignoreFocus },
			callback: dispatch,
		});
		return () => unregisterShortcut(id);
	}, [description, dispatch, id, ignoreFocus, keyCombo, registerShortcut, unregisterShortcut]);
};

export const useActiveShortcuts = () => {
	const { activeShortcuts } = useShortcutContext();
	return activeShortcuts;
};
