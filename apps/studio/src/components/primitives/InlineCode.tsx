import { cn } from "@/lib/utils";

/**
 * A run id, a node ref, an env var — mono text inside a bordered chip. Sizes are
 * type-scale names shared with `Paragraph`, so `<InlineCode variant="small">`
 * sits on the same line as a `small` paragraph without changing its height.
 */
const variants = {
	base: "text-base",
	small: "text-sm",
	"extra-small": "text-xs",
} as const;

type InlineCodeProps = React.ComponentPropsWithRef<"code"> & {
	variant?: keyof typeof variants;
};

export function InlineCode({ className, variant = "small", ...props }: InlineCodeProps) {
	return (
		<code
			className={cn(
				"rounded-md border border-line bg-control px-1 py-0.5 font-mono text-ink-strong",
				variants[variant],
				className,
			)}
			{...props}
		/>
	);
}
