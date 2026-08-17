import { createFileRoute, redirect } from "@tanstack/react-router";

// #769 asked for `/storybook` (trigger.dev's name for it). The catalog ships at
// `/catalog`, which is the name the E1 conventions doc hands to every downstream
// task. This alias keeps the ticket's URL working; delete it if nobody uses it.
export const Route = createFileRoute("/storybook")({
	beforeLoad: () => {
		throw redirect({ to: "/catalog" });
	},
});
