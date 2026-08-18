import { STATUS_COLORS, STATUS_DOT_COLORS, STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { NodeRunStatus, WorkflowRunStatus } from "@/types";

// The shared emphasis vocabulary (§2.10) — the same three names Button ships,
// applied to a chip: `primary` is the accent-emphasis badge, `secondary` the
// default control fill, `minimal` the transparent outline.
const variants = {
	primary: "border border-accent/30 bg-accent/10 text-accent",
	secondary: "border border-line bg-control text-ink",
	minimal: "border border-line-strong bg-transparent text-ink-dimmed",
} as const;

// The size ladder (`_design/CONVENTIONS.md` §2.4), rows `xs`/`sm`/`md`. `lg` is
// omitted — a 36px badge is a button. `md` stays because it is the mandated
// default for every sized primitive.
const sizes = {
	xs: "h-6 gap-1 px-2 text-xs",
	sm: "h-7 gap-1.5 px-2.5 text-xs",
	md: "h-8 gap-2 px-3 text-sm",
} as const;

type BadgeProps = React.ComponentPropsWithRef<"span"> & {
	variant?: keyof typeof variants;
	size?: keyof typeof sizes;
};

export function Badge({ className, variant = "secondary", size = "md", ...props }: BadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-md font-medium",
				variants[variant],
				sizes[size],
				className,
			)}
			{...props}
		/>
	);
}

// Folded in from `shared/StatusBadge.tsx` (§6). Same name, same props, same
// rendered output — `shared/StatusBadge.tsx` is now a one-line re-export of this
// and the frozen `__tests__/components.test.tsx` still passes untouched.
//
// It is deliberately NOT a `Badge` variant: the status pairing lives in
// `STATUS_COLORS` / `STATUS_DOT_COLORS` (§6.1), which already carry the fill/ink
// role split, and re-deriving it through the variant table would lose that.
interface StatusBadgeProps {
	status: WorkflowRunStatus | NodeRunStatus;
	className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
				STATUS_COLORS[status],
				className,
			)}
		>
			<span
				className={cn(
					"h-1.5 w-1.5 rounded-full",
					STATUS_DOT_COLORS[status],
					status === "running" && "animate-pulse-dot",
				)}
				aria-hidden="true"
			/>
			{STATUS_LABELS[status]}
		</span>
	);
}
