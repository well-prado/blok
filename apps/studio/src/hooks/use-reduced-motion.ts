import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | undefined {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
	return window.matchMedia(QUERY);
}

export function useReducedMotion() {
	const [matches, setMatch] = useState(() => reducedMotionQuery()?.matches ?? false);

	useEffect(() => {
		const mq = reducedMotionQuery();
		if (!mq) return;
		const onChange = () => setMatch(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	return matches;
}
