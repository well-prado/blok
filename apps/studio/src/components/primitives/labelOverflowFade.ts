import { useLayoutEffect, useRef, useState } from "react";

// A right-edge alpha mask, so a value that runs past its box fades out instead
// of being chopped mid-glyph. `black`/`transparent` here are mask channels, not
// paint — nothing on screen takes this color, so it is not a token bypass.
const FADE = "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]";

/** The fade class for an element that is overflowing, or `undefined` when it fits. */
export function labelOverflowFade(isOverflowing: boolean): string | undefined {
	return isOverflowing ? FADE : undefined;
}

/**
 * Attach `ref` to the scrolling element; `className` carries the fade only while
 * its content actually overflows. Re-measures on resize where `ResizeObserver`
 * exists (it does not in jsdom, hence the guard).
 */
export function useOverflowFade<T extends HTMLElement>(content: string) {
	const ref = useRef<T>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		// `content` is read here so a changed value re-measures; an empty one never overflows.
		const measure = () => setIsOverflowing(content.length > 0 && element.scrollWidth > element.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [content]);

	return { ref, className: labelOverflowFade(isOverflowing) };
}
