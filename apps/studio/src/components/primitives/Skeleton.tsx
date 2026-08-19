import { cn } from "@/lib/utils";

type SkeletonProps = React.ComponentPropsWithRef<"div">;

export function Skeleton({ className, ...props }: SkeletonProps) {
	return (
		<div className={cn("rounded-md bg-raised motion-safe:animate-pulse", className)} aria-hidden="true" {...props} />
	);
}
