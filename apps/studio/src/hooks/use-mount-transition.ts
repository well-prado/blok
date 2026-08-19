import { useEffect, useState } from "react";
import { useReducedMotion } from "./use-reduced-motion";

export function useMountTransition(isMounted: boolean, unmountDelay: number) {
	const [hasTransitionedIn, setHasTransitionedIn] = useState(false);
	const [render, setRender] = useState(isMounted);
	const prefersReducedMotion = useReducedMotion();

	useEffect(() => {
		let timeoutId: ReturnType<typeof setTimeout>;

		if (isMounted) {
			setRender(true);
			// Allow DOM to update before triggering transition
			timeoutId = setTimeout(() => {
				setHasTransitionedIn(true);
			}, 10);
		} else {
			setHasTransitionedIn(false);
			if (prefersReducedMotion) {
				setRender(false);
			} else {
				timeoutId = setTimeout(() => {
					setRender(false);
				}, unmountDelay);
			}
		}

		return () => {
			clearTimeout(timeoutId);
		};
	}, [isMounted, unmountDelay, prefersReducedMotion]);

	return { render, hasTransitionedIn };
}
