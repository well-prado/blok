import { cn } from "@/lib/utils";

const tones = {
	info: "bg-status-running",
	success: "bg-status-completed",
	warning: "bg-status-warning",
	error: "bg-status-failed",
	neutral: "bg-ink-muted",
} as const;

type PulsingDotProps = Omit<React.ComponentPropsWithRef<"span">, "children"> & {
	tone?: keyof typeof tones;
	isPulsing?: boolean;
	label?: string | null;
};

export function PulsingDot({
	className,
	tone = "neutral",
	isPulsing = true,
	label = "Live",
	...props
}: PulsingDotProps) {
	return (
		<span className={cn("relative flex h-1.5 w-1.5 items-center justify-center", className)} {...props}>
			{isPulsing && (
				<span
					className={cn("absolute inset-0 rounded-full opacity-75 motion-safe:animate-ping", tones[tone])}
					aria-hidden="true"
				/>
			)}
			<span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", tones[tone])} aria-hidden="true" />
			{label !== null && <span className="sr-only select-none">{label}</span>}
		</span>
	);
}
