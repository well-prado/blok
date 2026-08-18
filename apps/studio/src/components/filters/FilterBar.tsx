import { useFilterEngine } from "@/hooks/useFilterEngine";
import { FILTER_FIELDS, type FilterState, isFilterEmpty } from "@/lib/filterTypes";
import { cn } from "@/lib/utils";
import { AppliedFilterChip } from "./AppliedFilterChip";
import { FilterMenu } from "./FilterMenu";
import { TimePeriodFilter } from "./TimePeriodFilter";

import { SavedFilterSelect } from "./SavedFilterSelect";

interface FilterBarProps {
	className?: string;
}

export function FilterBar({ className }: FilterBarProps) {
	const { filters, setFilter, clearFilter, clearAll } = useFilterEngine();

	const isEmpty = isFilterEmpty(filters);

	const handleMenuSelect = (fieldKey: string, value: string) => {
		const currentVal = filters[fieldKey as keyof typeof filters];

		if (Array.isArray(currentVal)) {
			if (!currentVal.includes(value)) {
				setFilter(fieldKey as keyof FilterState, [...currentVal, value]);
			}
		} else if (fieldKey === "metadata") {
			const [k, v] = value.split(":");
			if (k && v) {
				setFilter("metadata", { ...filters.metadata, [k]: v });
			} else {
				setFilter("metadata", { ...filters.metadata, [value]: "true" });
			}
		} else {
			setFilter(fieldKey as keyof FilterState, value);
		}
	};

	const renderChips = () => {
		const chips = [];
		for (const field of FILTER_FIELDS) {
			const value = filters[field.key];
			if (Array.isArray(value)) {
				for (const v of value) {
					chips.push(
						<AppliedFilterChip
							key={`${field.key}-${v}`}
							field={field}
							value={v}
							onRemove={() => {
								const newArr = value.filter((item) => item !== v);
								if (newArr.length === 0) clearFilter(field.key);
								else setFilter(field.key as keyof FilterState, newArr);
							}}
						/>,
					);
				}
			} else if (typeof value === "string") {
				chips.push(
					<AppliedFilterChip key={field.key} field={field} value={value} onRemove={() => clearFilter(field.key)} />,
				);
			} else if (field.key === "metadata" && value && typeof value === "object" && !Array.isArray(value)) {
				for (const [k, v] of Object.entries(value)) {
					chips.push(
						<AppliedFilterChip
							key={`meta-${k}`}
							field={field}
							value={`${k}:${v}`}
							onRemove={() => {
								const newMeta = { ...(value as Record<string, string>) };
								delete newMeta[k];
								if (Object.keys(newMeta).length === 0) clearFilter("metadata");
								else setFilter("metadata", newMeta);
							}}
						/>,
					);
				}
			}
		}
		return chips;
	};

	return (
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			<FilterMenu onSelect={handleMenuSelect} />
			<TimePeriodFilter value={filters.timePeriod} onChange={(period) => setFilter("timePeriod", period)} />

			<div className="h-4 w-px bg-line mx-1" aria-hidden="true" />

			{renderChips()}

			{!isEmpty && (
				<button
					type="button"
					onClick={clearAll}
					className="text-xs font-medium text-zinc-400 hover:text-zinc-100 transition-colors ml-2"
				>
					Clear all
				</button>
			)}
			<SavedFilterSelect />
		</div>
	);
}
