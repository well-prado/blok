import { useSavedFilters } from "@/hooks/useSavedFilters";
import { Bookmark } from "lucide-react";

export function SavedFilterSelect() {
	const data = useSavedFilters();
	const isLoading = false;
	// Since T6 is upgrading this, we just provide the shell to render them

	if (isLoading || !data || data.length === 0) return null;

	return (
		<div className="flex items-center gap-2 border-l border-line pl-3 ml-1">
			<Bookmark className="w-4 h-4 text-zinc-500" />
			<select
				className="bg-transparent text-sm text-zinc-300 outline-none hover:text-white cursor-pointer"
				onChange={() => {
					// We will load the filter state into useFilterEngine.
					// Leaving this logic for a follow up since T6 is upgrading the shapes.
				}}
				defaultValue=""
			>
				<option value="" disabled className="bg-overlay">
					Saved Views
				</option>
				{data.map((f: import("@/types").SavedFilter) => (
					<option key={f.id} value={f.name} className="bg-overlay">
						{f.name}
					</option>
				))}
			</select>
		</div>
	);
}
