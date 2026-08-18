// @ts-nocheck
import { ShortcutKey } from "@/components/shared/ShortcutKey";

import { FILTER_FIELDS } from "@/lib/filterTypes";
import { cn } from "@/lib/utils";
import * as Popover from "@radix-ui/react-popover";
import { ChevronLeft, Search } from "lucide-react";
import * as React from "react";

export function FilterMenu({ onSelect }: { onSelect?: (field: string, value: string) => void } = {}) {
	const [open, setOpen] = React.useState(false);
	const [selectedField, setSelectedField] = React.useState<string | null>(null);
	const [inputValue, setInputValue] = React.useState("");
	const [activeIndex, setActiveIndex] = React.useState(0);

	const inputRef = React.useRef<HTMLInputElement>(null);

	const currentItems = React.useMemo(() => {
		if (selectedField) {
			const values: { id: string; label: string; icon?: React.ReactNode }[] = [
				{ id: "val-1", label: `Any ${selectedField}` },
				{ id: "val-2", label: `Specific ${selectedField}` },
			];
			return values.filter((v) => v.label.toLowerCase().includes(inputValue.toLowerCase()));
		}

		return FILTER_FIELDS.filter((f) => f.label.toLowerCase().includes(inputValue.toLowerCase())).map((f) => ({
			id: f.key,
			label: f.label,
			icon: f.icon,
		}));
	}, [selectedField, inputValue]);

	React.useEffect(() => {
		if (!open) {
			setSelectedField(null);
			setInputValue("");
			setActiveIndex(0);
		} else {
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [open]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((prev) => (prev < currentItems.length - 1 ? prev + 1 : prev));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((prev) => (prev > 0 ? prev - 1 : prev));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (currentItems.length > 0) {
				const item = currentItems[activeIndex];
				if (item && !selectedField) {
					setSelectedField(item.id);
					setInputValue("");
					setActiveIndex(0);
				} else if (item) {
					setOpen(false);
					onSelect?.(selectedField, item.id);
				}
			}
		} else if (e.key === "Escape") {
			if (selectedField) {
				e.preventDefault();
				e.stopPropagation();
				setSelectedField(null);
				setInputValue("");
				setActiveIndex(0);
			}
		} else if (e.key === "Backspace" && inputValue === "" && selectedField) {
			setSelectedField(null);
			setActiveIndex(0);
		}
	};

	React.useEffect(() => {
		const handleGlobalKeyDown = (e: KeyboardEvent) => {
			if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
				const activeElement = document.activeElement as HTMLElement;
				const isInput = activeElement?.tagName === "INPUT" || activeElement?.tagName === "TEXTAREA";
				if (!isInput && !open) {
					e.preventDefault();
					setOpen(true);
				}
			}
		};
		document.addEventListener("keydown", handleGlobalKeyDown);
		return () => document.removeEventListener("keydown", handleGlobalKeyDown);
	}, [open]);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="focus-ring inline-flex h-8 items-center gap-2 rounded-md border border-line bg-control pl-3 pr-2 text-sm text-ink hover:bg-hover transition-colors"
				>
					<span>Filter...</span>
					<ShortcutKey shortcut="F" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					className="z-50 flex w-64 flex-col rounded-md border border-line bg-overlay p-1 shadow-lg outline-none"
				>
					<div className="flex items-center gap-2 border-b border-line px-2 py-1">
						{selectedField ? (
							<button
								type="button"
								className="focus-ring rounded text-ink-dimmed hover:text-ink"
								onClick={() => {
									setSelectedField(null);
									setInputValue("");
									setActiveIndex(0);
									inputRef.current?.focus();
								}}
								aria-label="Back to fields"
							>
								<ChevronLeft className="h-4 w-4" aria-hidden="true" />
							</button>
						) : (
							<Search className="h-4 w-4 shrink-0 text-ink-dimmed" aria-hidden="true" />
						)}
						<input
							ref={inputRef}
							role="combobox"
							aria-expanded={currentItems.length > 0}
							aria-controls="filter-menu-list"
							aria-activedescendant={
								currentItems.length > 0 && currentItems[activeIndex]
									? `filter-item-${currentItems[activeIndex].id}`
									: undefined
							}
							className="flex-1 bg-transparent py-1.5 text-sm text-ink outline-none placeholder:text-ink-dimmed"
							placeholder={selectedField ? "Search values..." : "Filter by..."}
							value={inputValue}
							onChange={(e) => {
								setInputValue(e.target.value);
								setActiveIndex(0);
							}}
							onKeyDown={handleKeyDown}
						/>
					</div>
					<ul id="filter-menu-list" className="max-h-64 overflow-y-auto py-1">
						{currentItems.length === 0 ? (
							<li className="px-2 py-2 text-center text-sm text-ink-dimmed">No results found.</li>
						) : (
							currentItems.map((item, index) => {
								const isActive = index === activeIndex;
								return (
									<li
										key={item.id}
										id={`filter-item-${item.id}`}
										aria-selected={isActive}
										className={cn(
											"flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
											isActive ? "bg-hover text-ink" : "text-ink-muted",
										)}
										onMouseEnter={() => setActiveIndex(index)}
										onClick={() => {
											if (!selectedField) {
												setSelectedField(item.id);
												setInputValue("");
												setActiveIndex(0);
												inputRef.current?.focus();
											} else {
												setOpen(false);
												onSelect?.(selectedField, item.id);
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												if (!selectedField) {
													setSelectedField(item.id);
													setInputValue("");
													setActiveIndex(0);
													inputRef.current?.focus();
												} else {
													setOpen(false);
													onSelect?.(selectedField, item.id);
												}
											}
										}}
									>
										{item.icon && (
											<span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
												{item.icon}
											</span>
										)}
										<span className="truncate">{item.label}</span>
									</li>
								);
							})
						)}
					</ul>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
