import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface PageAccessoriesProps {
	children: ReactNode;
	className?: string;
}

export function PageAccessories({
	children,
	className,
	...props
}: PageAccessoriesProps & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div className={cn("flex items-center gap-2", className)} {...props}>
			{children}
		</div>
	);
}
