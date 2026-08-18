import { cn } from "@/lib/utils";

// Only the TEXT column of the ladder applies — a label has no box.
const sizes = {
	xs: "text-xs",
	sm: "text-xs",
	md: "text-sm",
	lg: "text-sm",
} as const;

type LabelProps = React.ComponentPropsWithRef<"label"> & {
	size?: keyof typeof sizes;
	/** `false` appends a visible "(optional)". Matches the reference's default. */
	required?: boolean;
};

// `htmlFor` is destructured rather than left in the spread on purpose: it is
// the whole point of a Label, and pulling it out is what lets
// `lint/a11y/noLabelWithoutControl` see the association (§9 bans the
// suppression, so the markup has to be honest instead).
export function Label({ className, children, htmlFor, size = "md", required = true, ...props }: LabelProps) {
	return (
		<label
			htmlFor={htmlFor}
			className={cn("flex items-center gap-1 font-medium leading-tight text-ink", sizes[size], className)}
			{...props}
		>
			{children}
			{!required && <span className="font-normal text-ink-muted">(optional)</span>}
		</label>
	);
}
