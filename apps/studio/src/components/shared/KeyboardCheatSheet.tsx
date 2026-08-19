import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/primitives/Dialog";
import { ShortcutKey } from "@/components/shared/ShortcutKey";
import { useActiveShortcuts } from "@/hooks/useShortcuts";
import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";

export function KeyboardCheatSheet({
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
}: {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const activeShortcuts = useActiveShortcuts();

	const isControlled = controlledOpen !== undefined;
	const open = isControlled ? controlledOpen : internalOpen;
	const setOpen = isControlled && controlledOnOpenChange ? controlledOnOpenChange : setInternalOpen;

	useEffect(() => {
		if (isControlled) return;
		const handleOpen = () => setOpen(true);
		window.addEventListener("blok:open-cheat-sheet", handleOpen);
		return () => window.removeEventListener("blok:open-cheat-sheet", handleOpen);
	}, [isControlled, setOpen]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Keyboard className="h-4 w-4 text-ink-dimmed" />
						Keyboard Shortcuts
					</DialogTitle>
				</DialogHeader>
				<DialogBody className="p-0">
					<div className="flex flex-col divide-y divide-line">
						{activeShortcuts.length === 0 ? (
							<div className="p-4 text-center text-sm text-ink-dimmed">No shortcuts active.</div>
						) : (
							activeShortcuts.map((shortcut, idx) => (
								<div
									key={`${shortcut.keyCombo}-${idx}`}
									className="flex items-center justify-between px-4 py-3 hover:bg-hover transition-colors"
								>
									<span className="text-sm text-ink">{shortcut.description || "Unnamed shortcut"}</span>
									<ShortcutKey shortcut={shortcut.keyCombo} />
								</div>
							))
						)}
					</div>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
