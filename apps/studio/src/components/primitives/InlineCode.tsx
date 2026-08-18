import { cn } from "@/lib/utils";

/**
 * A run id, a node ref, an env var — mono text inside a bordered chip. It takes
 * §2.4a's TEXT ladder, the same rows as `Paragraph`, so `<InlineCode size="md">`
 * sits on the same line as an `md` paragraph without changing its height.
 */
const sizes = {
	sm: "text-xs",
	md: "text-sm",
	lg: "text-base",
} as const;

type InlineCodeProps = React.ComponentPropsWithRef<"code"> & {
	size?: keyof typeof sizes;
};

export function InlineCode({ className, size = "md", ...props }: InlineCodeProps) {
	return (
		<code
			className={cn(
				"rounded-md border border-line bg-control px-1 py-0.5 font-mono text-ink-strong",
				sizes[size],
				className,
			)}
			{...props}
		/>
	);
}
