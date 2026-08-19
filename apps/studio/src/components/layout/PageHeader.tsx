import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface PageHeaderProps {
	children: ReactNode;
	className?: string;
}

export function PageHeader({ children, className, ...props }: PageHeaderProps & React.HTMLAttributes<HTMLElement>) {
	return (
		<header
			className={cn("flex flex-col sm:flex-row sm:items-start justify-between gap-4 shrink-0", className)}
			{...props}
		>
			{children}
		</header>
	);
}
