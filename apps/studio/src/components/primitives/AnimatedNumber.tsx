import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

type AnimatedNumberProps = Omit<React.ComponentPropsWithRef<"span">, "children"> & {
	value: number;
	format?: (value: number) => React.ReactNode;
};

function useReducedMotion() {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(mql.matches);
		const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);
	return reduced;
}

export function AnimatedNumber({ value, format, className, ...props }: AnimatedNumberProps) {
	const [displayValue, setDisplayValue] = useState(value);
	const prefersReducedMotion = useReducedMotion();

	// biome-ignore lint/correctness/useExhaustiveDependencies: explicitly omitting displayValue to avoid infinite loops
	useEffect(() => {
		if (prefersReducedMotion) {
			setDisplayValue(value);
			return;
		}

		if (displayValue === value) return;

		const startValue = displayValue;
		const endValue = value;
		const duration = 300;
		let startTime: number | null = null;
		let frameId: number;

		const animate = (timestamp: number) => {
			if (startTime === null) startTime = timestamp;
			const progress = Math.min((timestamp - startTime) / duration, 1);
			const easeProgress = 1 - (1 - progress) ** 5; // easeOutQuint

			setDisplayValue(startValue + (endValue - startValue) * easeProgress);

			if (progress < 1) {
				frameId = requestAnimationFrame(animate);
			} else {
				setDisplayValue(endValue);
			}
		};

		frameId = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(frameId);
	}, [value, prefersReducedMotion]);

	// In case value jumps significantly before mount finishes, ensure displayValue is not stuck
	const finalValue = prefersReducedMotion ? value : displayValue;
	const formattedValue = format ? format(finalValue) : Math.round(finalValue).toString();

	return (
		<span className={cn("inline-block tabular-nums", className)} {...props}>
			{formattedValue}
		</span>
	);
}
