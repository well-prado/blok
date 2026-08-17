import { cn } from "@/lib/utils";

/**
 * Body copy. Two orthogonal tables instead of the reference's 18 slash-encoded
 * cross-product keys (`base/bright`, `extra-small/dimmed/mono`, …) — size and
 * ink are independent choices, and a 3×4 lookup beats twelve string literals.
 *
 * Zero margin by default; `spacing` is opt-in (`_design/CONVENTIONS.md` §2.3).
 * The keys are type-scale names, not the §2.4 control ladder: a paragraph has
 * no box, so it takes no height, padding, or gap from that row.
 */
const variants = {
	base: { text: "text-base", spacing: "mb-3" },
	small: { text: "text-sm", spacing: "mb-2" },
	"extra-small": { text: "text-xs", spacing: "mb-1.5" },
} as const;

const tones = {
	ink: "text-ink",
	strong: "text-ink-strong",
	dimmed: "text-ink-dimmed",
	muted: "text-ink-muted",
} as const;

type ParagraphProps = React.ComponentPropsWithRef<"p"> & {
	variant?: keyof typeof variants;
	tone?: keyof typeof tones;
	/** Apply the variant's bottom margin. Off by default. */
	spacing?: boolean;
};

export function Paragraph({ className, variant = "small", tone = "ink", spacing = false, ...props }: ParagraphProps) {
	return (
		<p
			className={cn(variants[variant].text, tones[tone], spacing && variants[variant].spacing, className)}
			{...props}
		/>
	);
}
