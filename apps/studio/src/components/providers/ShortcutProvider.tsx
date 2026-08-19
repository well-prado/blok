import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";

export interface ShortcutOptions {
	description?: string;
	ignoreFocus?: boolean;
}

export interface ParsedCombo {
	mod: boolean;
	alt: boolean;
	shift: boolean;
	key: string;
}

export interface RegisteredShortcut {
	id: string;
	keyCombo: string;
	parsedSequence: ParsedCombo[];
	options?: ShortcutOptions;
	callback: (e: KeyboardEvent) => void;
}

interface ShortcutContextValue {
	registerShortcut: (shortcut: RegisteredShortcut) => void;
	unregisterShortcut: (id: string) => void;
	activeShortcuts: Array<{ keyCombo: string; description?: string }>;
}

export const ShortcutContext = createContext<ShortcutContextValue | null>(null);

export const parsePart = (part: string): ParsedCombo => {
	const parts = part
		.toLowerCase()
		.split("+")
		.map((p) => p.trim());
	const mod = parts.includes("mod") || parts.includes("ctrl") || parts.includes("meta");
	const alt = parts.includes("alt");
	const shift = parts.includes("shift");
	const key = parts.filter((p) => !["mod", "ctrl", "meta", "alt", "shift"].includes(p))[0] || "";
	return { mod, alt, shift, key };
};

export const parseSequence = (seq: string): ParsedCombo[] => {
	return seq.split(" ").filter(Boolean).map(parsePart);
};

export const ShortcutProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [shortcuts, setShortcuts] = useState<RegisteredShortcut[]>([]);
	const shortcutsRef = useRef<RegisteredShortcut[]>([]);
	const sequenceBufferRef = useRef<
		Array<{ mod: boolean; alt: boolean; shift: boolean; key: string; isLetter: boolean }>
	>([]);
	const sequenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		shortcutsRef.current = shortcuts;
	}, [shortcuts]);

	const registerShortcut = useCallback((shortcut: RegisteredShortcut) => {
		setShortcuts((prev) => {
			const existingIndex = prev.findIndex((s) => s.id === shortcut.id);
			if (existingIndex >= 0) {
				const next = [...prev];
				next[existingIndex] = shortcut;
				return next;
			}
			return [...prev, shortcut];
		});
	}, []);

	const unregisterShortcut = useCallback((id: string) => {
		setShortcuts((prev) => prev.filter((s) => s.id !== id));
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const isModifierEvent = ["Control", "Alt", "Shift", "Meta"].includes(e.key);
			if (isModifierEvent) return;

			const activeElement = document.activeElement;
			const isInputFocused =
				activeElement instanceof HTMLInputElement ||
				activeElement instanceof HTMLTextAreaElement ||
				(activeElement instanceof HTMLElement && activeElement.isContentEditable);

			const ev = {
				mod: e.ctrlKey || e.metaKey,
				alt: e.altKey,
				shift: e.shiftKey,
				key: e.key.toLowerCase(),
				isLetter: e.key.length === 1 && /[a-z]/i.test(e.key),
			};

			const matchesPart = (parsed: ParsedCombo, eventEv: typeof ev) => {
				if (parsed.mod !== eventEv.mod) return false;
				if (parsed.alt !== eventEv.alt) return false;
				if (parsed.key !== eventEv.key) return false;

				if (eventEv.isLetter) {
					if (parsed.shift !== eventEv.shift) return false;
				} else {
					if (parsed.shift && !eventEv.shift) return false;
				}
				return true;
			};

			const matchesSequence = (parsedSeq: ParsedCombo[], eventSeq: (typeof ev)[]) => {
				if (parsedSeq.length !== eventSeq.length) return false;
				return parsedSeq.every((part, i) => matchesPart(part, eventSeq[i] as NonNullable<(typeof eventSeq)[0]>));
			};

			const matchesPartialSequence = (parsedSeq: ParsedCombo[], eventSeq: (typeof ev)[]) => {
				if (eventSeq.length >= parsedSeq.length) return false;
				return eventSeq.every((part, i) => matchesPart(parsedSeq[i] as ParsedCombo, part));
			};

			const evaluateBuffer = (buffer: (typeof ev)[]) => {
				let hasPartial = false;
				for (const shortcut of shortcutsRef.current) {
					if (matchesSequence(shortcut.parsedSequence, buffer)) {
						if (isInputFocused && !shortcut.options?.ignoreFocus) continue;
						shortcut.callback(e);
						return { matched: true, partial: false };
					}
					if (matchesPartialSequence(shortcut.parsedSequence, buffer)) {
						if (isInputFocused && !shortcut.options?.ignoreFocus) continue;
						hasPartial = true;
					}
				}
				return { matched: false, partial: hasPartial };
			};

			sequenceBufferRef.current.push(ev);

			let result = evaluateBuffer(sequenceBufferRef.current);

			if (result.matched) {
				sequenceBufferRef.current = [];
				if (sequenceTimeoutRef.current) clearTimeout(sequenceTimeoutRef.current);
			} else if (result.partial) {
				if (sequenceTimeoutRef.current) clearTimeout(sequenceTimeoutRef.current);
				sequenceTimeoutRef.current = setTimeout(() => {
					sequenceBufferRef.current = [];
				}, 500);
			} else {
				if (sequenceBufferRef.current.length > 1) {
					sequenceBufferRef.current = [ev];
					result = evaluateBuffer(sequenceBufferRef.current);
					if (result.matched) {
						sequenceBufferRef.current = [];
						if (sequenceTimeoutRef.current) clearTimeout(sequenceTimeoutRef.current);
					} else if (result.partial) {
						if (sequenceTimeoutRef.current) clearTimeout(sequenceTimeoutRef.current);
						sequenceTimeoutRef.current = setTimeout(() => {
							sequenceBufferRef.current = [];
						}, 500);
					} else {
						sequenceBufferRef.current = [];
					}
				} else {
					sequenceBufferRef.current = [];
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			if (sequenceTimeoutRef.current) clearTimeout(sequenceTimeoutRef.current);
		};
	}, []);

	const activeShortcuts = React.useMemo(() => {
		return shortcuts.map((s) => ({
			keyCombo: s.keyCombo,
			description: s.options?.description,
		}));
	}, [shortcuts]);

	const value = React.useMemo(
		() => ({ registerShortcut, unregisterShortcut, activeShortcuts }),
		[registerShortcut, unregisterShortcut, activeShortcuts],
	);

	return <ShortcutContext.Provider value={value}>{children}</ShortcutContext.Provider>;
};

export const useShortcutContext = () => {
	const ctx = useContext(ShortcutContext);
	if (!ctx) {
		throw new Error("useShortcutContext must be used within a ShortcutProvider");
	}
	return ctx;
};
