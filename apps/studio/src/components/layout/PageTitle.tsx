import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface PageTitleProps {
	children: ReactNode;
	className?: string;
}

export function PageTitle({
	children,
	className,
	...props
}: PageTitleProps & React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h1 className={cn("text-2xl font-medium font-display italic tracking-tight text-zinc-100", className)} {...props}>
			{children}
		</h1>
	);
}
