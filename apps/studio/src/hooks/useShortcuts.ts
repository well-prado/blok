import { useEffect, useId } from "react";
import { parseSequence, useShortcutContext } from "../components/providers/ShortcutProvider";

export interface ShortcutOptions {
	description?: string;
	ignoreFocus?: boolean;
}

export const useShortcut = (keyCombo: string, callback: (e: KeyboardEvent) => void, options?: ShortcutOptions) => {
	const { registerShortcut, unregisterShortcut } = useShortcutContext();
	const id = useId();

	useEffect(() => {
		registerShortcut({
			id,
			keyCombo,
			parsedSequence: parseSequence(keyCombo),
			options,
			callback,
		});
		return () => unregisterShortcut(id);
	}, [id, keyCombo, options, callback, registerShortcut, unregisterShortcut]);
};

export const useActiveShortcuts = () => {
	const { activeShortcuts } = useShortcutContext();
	return activeShortcuts;
};
