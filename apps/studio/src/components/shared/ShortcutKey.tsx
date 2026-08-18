import { cn } from "@/lib/utils";

export function ShortcutKey({ shortcut, className }: { shortcut: string; className?: string }) {
	return (
		<kbd
			className={cn(
				"inline-flex items-center justify-center rounded border border-line bg-canvas px-1.5 text-[10px] font-medium text-zinc-500",
				className,
			)}
		>
			{shortcut}
		</kbd>
	);
}
