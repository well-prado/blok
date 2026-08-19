import { cn } from "@/lib/utils";

type LoadingBarDividerProps = React.ComponentPropsWithRef<"div"> & {
	isLoading?: boolean;
};

export function LoadingBarDivider({ className, isLoading = true, ...props }: LoadingBarDividerProps) {
	return (
		<div className={cn("h-0.5 w-full overflow-hidden bg-line", className)} aria-hidden="true" {...props}>
			{isLoading && <div className="h-full w-full origin-left bg-accent motion-safe:animate-grow-bar" />}
		</div>
	);
}
