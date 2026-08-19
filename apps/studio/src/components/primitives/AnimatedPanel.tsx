import { useMountTransition } from "@/hooks/use-mount-transition";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import type * as React from "react";

export interface AnimatedPanelProps extends React.HTMLAttributes<HTMLDivElement> {
	isVisible?: boolean;
	unmountDelay?: number;
}

export function AnimatedPanel({
	isVisible = true,
	unmountDelay = 300,
	className,
	children,
	...props
}: AnimatedPanelProps) {
	const { render, hasTransitionedIn } = useMountTransition(isVisible, unmountDelay);
	const prefersReducedMotion = useReducedMotion();

	if (!render) {
		return null;
	}

	return (
		<div
			className={cn(
				!prefersReducedMotion && "transition-all duration-300 ease-out",
				!hasTransitionedIn && !prefersReducedMotion
					? "opacity-0 scale-95 translate-y-2"
					: "opacity-100 scale-100 translate-y-0",
				className,
			)}
			data-testid="animated-panel"
			{...props}
		>
			{children}
		</div>
	);
}
