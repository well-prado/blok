import { cn } from "@/lib/utils";

interface EmptyStateProps {
	icon: React.ReactNode;
	title: string;
	description: string;
	action?: React.ReactNode;
	className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
	return (
		<div className={cn("flex flex-col items-center justify-center py-16 px-4 text-center", className)}>
			<div className="mb-4 text-zinc-600">{icon}</div>
			<h3 className="text-lg font-medium text-zinc-300 mb-1">{title}</h3>
			<p className="text-sm text-zinc-500 max-w-sm mb-4">{description}</p>
			{action}
		</div>
	);
}
