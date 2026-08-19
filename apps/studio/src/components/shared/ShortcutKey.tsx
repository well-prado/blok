import { cn } from "@/lib/utils";

function isMac() {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
}

function formatCombination(combination: string, mac: boolean): string {
	const keys = combination.split("+");

	if (mac) {
		return keys
			.map((key) => {
				const lower = key.toLowerCase();
				if (lower === "mod") return "⌘";
				if (lower === "alt") return "⌥";
				if (lower === "shift") return "⇧";
				if (lower === "ctrl" || lower === "control") return "⌃";
				return key;
			})
			.join("");
	}
	return keys
		.map((key) => {
			const lower = key.toLowerCase();
			if (lower === "mod") return "Ctrl";
			if (lower === "alt") return "Alt";
			if (lower === "shift") return "Shift";
			return key;
		})
		.join("+");
}

export function ShortcutKey({ shortcut, className }: { shortcut: string; className?: string }) {
	const mac = isMac();
	const sequences = shortcut.split(" ").filter(Boolean);

	if (sequences.length === 1) {
		return (
			<kbd
				className={cn(
					"inline-flex items-center justify-center rounded border border-line bg-canvas px-1.5 text-[10px] font-medium text-zinc-500",
					className,
				)}
			>
				{formatCombination(sequences[0] as NonNullable<(typeof sequences)[0]>, mac)}
			</kbd>
		);
	}

	return (
		<span className="inline-flex items-center gap-1">
			{sequences.map((seq, i) => (
				<kbd
					// biome-ignore lint/suspicious/noArrayIndexKey: order is static and list is bounded
					key={`${seq}-${i}`}
					className={cn(
						"inline-flex items-center justify-center rounded border border-line bg-canvas px-1.5 text-[10px] font-medium text-zinc-500",
						className,
					)}
				>
					{formatCombination(seq, mac)}
				</kbd>
			))}
		</span>
	);
}
