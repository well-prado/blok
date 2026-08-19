import { useShortcut } from "@/hooks/useShortcuts";
import { useNavigate } from "@tanstack/react-router";
import type React from "react";

export const GlobalShortcuts: React.FC = () => {
	const navigate = useNavigate();

	// Navigation shortcuts
	useShortcut(
		"g r",
		(e) => {
			e.preventDefault();
			navigate({ to: "/runs" });
		},
		{ description: "Go to runs" },
	);

	useShortcut(
		"g d",
		(e) => {
			e.preventDefault();
			navigate({ to: "/" });
		},
		{ description: "Go to dashboards" },
	);

	useShortcut(
		"g l",
		(e) => {
			e.preventDefault();
			navigate({ to: "/logs" });
		},
		{ description: "Go to logs" },
	);

	useShortcut(
		"g m",
		(e) => {
			e.preventDefault();
			navigate({ to: "/metrics" });
		},
		{ description: "Go to metrics" },
	);

	useShortcut(
		"g q",
		(e) => {
			e.preventDefault();
			navigate({ to: "/queues" });
		},
		{ description: "Go to queues" },
	);

	useShortcut(
		"g v",
		(e) => {
			e.preventDefault();
			navigate({ to: "/deployments" });
		},
		{ description: "Go to deployments" },
	);

	// Action shortcuts
	useShortcut(
		"e",
		(e) => {
			e.preventDefault();
			document.dispatchEvent(new CustomEvent("blok:open-env-switcher"));
		},
		{ description: "Open environment switcher" },
	);

	useShortcut(
		"mod+k",
		(e) => {
			e.preventDefault();
			document.dispatchEvent(new CustomEvent("blok:open-command-palette"));
		},
		{ description: "Open command palette" },
	);

	useShortcut(
		"?",
		(e) => {
			e.preventDefault();
			document.dispatchEvent(new CustomEvent("blok:open-cheat-sheet"));
		},
		{ description: "Open cheat sheet" },
	);

	return null;
};
