import { cn } from "@/lib/utils";
import { ChevronDown, Download, FileJson, FileSpreadsheet } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ExportMenuProps {
	onExportJson: () => void;
	onExportCsv: () => void;
	label?: string;
	size?: "sm" | "md";
}

export function ExportMenu({ onExportJson, onExportCsv, label = "Export", size = "sm" }: ExportMenuProps) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={cn(
					"flex items-center gap-1.5 rounded-md font-medium transition-colors bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100",
					size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
				)}
			>
				<Download className={size === "sm" ? "w-3 h-3" : "w-4 h-4"} />
				{label}
				<ChevronDown
					className={cn("transition-transform", size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5", open && "rotate-180")}
				/>
			</button>

			{open && (
				<div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
					<button
						type="button"
						onClick={() => {
							onExportJson();
							setOpen(false);
						}}
						className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
					>
						<FileJson className="w-4 h-4 text-blue-400" />
						Export as JSON
					</button>
					<button
						type="button"
						onClick={() => {
							onExportCsv();
							setOpen(false);
						}}
						className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
					>
						<FileSpreadsheet className="w-4 h-4 text-green-400" />
						Export as CSV
					</button>
				</div>
			)}
		</div>
	);
}
