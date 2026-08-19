import type React from "react";
import { twMerge } from "tailwind-merge";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface AnimatingArrowProps extends React.SVGProps<SVGSVGElement> {
	className?: string;
}

export const AnimatingArrow: React.FC<AnimatingArrowProps> = ({ className, ...props }) => {
	const reducedMotion = useReducedMotion();

	if (reducedMotion) {
		return (
			// biome-ignore lint/a11y/noSvgWithoutTitle: presentation only
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="24"
				height="24"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className={twMerge("lucide lucide-arrow-right", className)}
				{...props}
			>
				<path d="M5 12h14" />
				<path d="m12 5 7 7-7 7" />
			</svg>
		);
	}

	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: presentation only
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={twMerge("lucide lucide-arrow-right overflow-visible", className)}
			{...props}
		>
			<path
				d="M5 12h14"
				className="transition-transform duration-normal ease-out-back origin-left scale-x-[0.6] group-hover:scale-x-100"
			/>
			<path
				d="m12 5 7 7-7 7"
				className="transition-transform duration-normal ease-out-back -translate-x-1 group-hover:translate-x-0"
			/>
		</svg>
	);
};
