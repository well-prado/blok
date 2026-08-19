import { create } from "zustand";
import { persist } from "zustand/middleware";

interface NavigationState {
	isCollapsed: boolean;
	favorites: string[];
	navOrder: string[];
	toggleCollapse: () => void;
	setCollapsed: (collapsed: boolean) => void;
	toggleFavorite: (id: string) => void;
	setNavOrder: (order: string[]) => void;
}

export const useNavigationStore = create<NavigationState>()(
	persist(
		(set) => ({
			isCollapsed: false,
			favorites: [],
			navOrder: [
				"/",
				"/dashboards",
				"/runs",
				"/scheduled",
				"/logs",
				"/queues",
				"/deployments",
				"/metrics",
				"/webhooks",
				"/catalog",
			],
			toggleCollapse: () => set((state) => ({ isCollapsed: !state.isCollapsed })),
			setCollapsed: (isCollapsed) => set({ isCollapsed }),
			toggleFavorite: (id) =>
				set((state) => ({
					favorites: state.favorites.includes(id) ? state.favorites.filter((f) => f !== id) : [...state.favorites, id],
				})),
			setNavOrder: (navOrder) => set({ navOrder }),
		}),
		{
			name: "blok-navigation-storage",
		},
	),
);
