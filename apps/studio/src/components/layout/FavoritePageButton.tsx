import { cn } from "@/lib/utils";
import { useNavigationStore } from "@/stores/navigation";
import { Star } from "lucide-react";

interface FavoritePageButtonProps {
	id: string;
	className?: string;
	isHoverOnly?: boolean;
}

export function FavoritePageButton({ id, className, isHoverOnly }: FavoritePageButtonProps) {
	const favorites = useNavigationStore((s) => s.favorites);
	const toggleFavorite = useNavigationStore((s) => s.toggleFavorite);
	const isFavorite = favorites.includes(id);

	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				toggleFavorite(id);
			}}
			className={cn(
				"rounded-md p-1 transition-all",
				isFavorite ? "text-yellow-500" : "text-zinc-500 hover:text-yellow-500/70",
				isHoverOnly && !isFavorite ? "opacity-0 group-hover:opacity-100" : "opacity-100",
				className,
			)}
			title={isFavorite ? "Remove from favorites" : "Add to favorites"}
		>
			<Star className={cn("h-3.5 w-3.5", isFavorite && "fill-current")} />
		</button>
	);
}
