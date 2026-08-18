import { Button } from "@/components/primitives/Buttons";
import { Input } from "@/components/primitives/Input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Popover";
import type { TimePeriod } from "@/lib/filterTypes";
import { formatTimePeriod, parsePeriodString, toDateTimeLocalString } from "@/lib/timePeriod";
import { Clock } from "lucide-react";
import { useEffect, useState } from "react";

interface TimePeriodFilterProps {
	value: TimePeriod | null;
	onChange: (val: TimePeriod | null) => void;
}

const PRESETS = ["1m", "5m", "30m", "1h", "6h", "12h", "1d", "3d", "7d", "14d", "30d"];

export function TimePeriodFilter({ value, onChange }: TimePeriodFilterProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [customInput, setCustomInput] = useState("");

	const [absFrom, setAbsFrom] = useState("");
	const [absTo, setAbsTo] = useState("");

	useEffect(() => {
		if (value?.type === "absolute") {
			setAbsFrom(toDateTimeLocalString(new Date(value.from)));
			setAbsTo(toDateTimeLocalString(new Date(value.to)));
		} else {
			setAbsFrom("");
			setAbsTo("");
		}
	}, [value]);

	const handlePresetClick = (preset: string) => {
		onChange({ type: "relative", value: preset });
		setIsOpen(false);
	};

	const handleCustomRelativeSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const parsed = parsePeriodString(customInput);
		if (parsed) {
			onChange(parsed);
			setIsOpen(false);
			setCustomInput("");
		}
	};

	const applyAbsoluteRange = () => {
		if (absFrom && absTo) {
			const fromTime = new Date(absFrom).getTime();
			const toTime = new Date(absTo).getTime();
			if (!Number.isNaN(fromTime) && !Number.isNaN(toTime)) {
				onChange({ type: "absolute", from: fromTime, to: toTime });
				setIsOpen(false);
			}
		}
	};

	const handleClear = () => {
		onChange(null);
		setIsOpen(false);
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>
				<Button variant={value ? "primary" : "secondary"} size="md" leadingIcon={<Clock />}>
					{value ? formatTimePeriod(value) : "Time Period"}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80" sideOffset={8}>
				<div className="space-y-4">
					<div>
						<p className="mb-1.5 text-xs font-semibold text-ink-strong">Relative Presets</p>
						<div className="grid grid-cols-4 gap-2">
							{PRESETS.map((preset) => {
								const isSelected = value?.type === "relative" && value.value === preset;
								return (
									<Button
										key={preset}
										variant={isSelected ? "primary" : "secondary"}
										size="sm"
										onClick={() => handlePresetClick(preset)}
										className="w-full"
									>
										{preset}
									</Button>
								);
							})}
						</div>
					</div>

					<form onSubmit={handleCustomRelativeSubmit}>
						<p className="mb-1.5 text-xs font-semibold text-ink-strong">Custom Relative</p>
						<div className="flex gap-2">
							<Input
								size="sm"
								placeholder="e.g. 45m, 2h"
								value={customInput}
								onChange={(e) => setCustomInput(e.target.value)}
							/>
							<Button type="submit" variant="secondary" size="sm" disabled={!customInput}>
								Apply
							</Button>
						</div>
					</form>

					<div>
						<p className="mb-1.5 text-xs font-semibold text-ink-strong">Absolute Range</p>
						<div className="space-y-2">
							<div className="flex flex-col gap-1">
								<label htmlFor="abs-from" className="text-xs text-ink-muted">
									From
								</label>
								<Input
									id="abs-from"
									type="datetime-local"
									size="sm"
									value={absFrom}
									onChange={(e) => setAbsFrom(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<label htmlFor="abs-to" className="text-xs text-ink-muted">
									To
								</label>
								<Input
									id="abs-to"
									type="datetime-local"
									size="sm"
									value={absTo}
									onChange={(e) => setAbsTo(e.target.value)}
								/>
							</div>
							<Button
								variant="secondary"
								size="sm"
								className="w-full"
								onClick={applyAbsoluteRange}
								disabled={!absFrom || !absTo}
							>
								Apply Range
							</Button>
						</div>
					</div>

					{value && (
						<Button variant="minimal" size="sm" className="w-full mt-2" onClick={handleClear}>
							Clear Filter
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
