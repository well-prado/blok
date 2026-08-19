import { useMountTransition } from "@/hooks/use-mount-transition";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import type * as React from "react";

export interface AnimatedCalloutProps extends React.HTMLAttributes<HTMLDivElement> {
	isVisible: boolean;
	unmountDelay?: number;
	slideDirection?: "up" | "down" | "left" | "right";
}

const directionClasses = {
	up: "translate-y-4",
	down: "-translate-y-4",
	left: "translate-x-4",
	right: "-translate-x-4",
};

export function AnimatedCallout({
	isVisible,
	unmountDelay = 300,
	slideDirection = "up",
	className,
	children,
	...props
}: AnimatedCalloutProps) {
	const { render, hasTransitionedIn } = useMountTransition(isVisible, unmountDelay);
	const prefersReducedMotion = useReducedMotion();

	if (!render) {
		return null;
	}

	const baseStyles = "transition-all duration-300 ease-in-out";
	const transformClass = directionClasses[slideDirection];

	return (
		<div
			className={cn(
				!prefersReducedMotion && baseStyles,
				!hasTransitionedIn && !prefersReducedMotion
					? `opacity-0 ${transformClass}`
					: "opacity-100 translate-y-0 translate-x-0",
				className,
			)}
			data-testid="animated-callout"
			{...props}
		>
			{children}
		</div>
	);
}
