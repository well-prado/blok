import { cn } from "@/lib/utils";

/**
 * Body copy. Two orthogonal tables instead of the reference's 18 slash-encoded
 * cross-product keys (`base/bright`, `extra-small/dimmed/mono`, …) — scale and
 * ink are independent choices, and a 3×4 lookup beats twelve string literals.
 *
 * Zero margin by default; `spacing` is opt-in (`_design/CONVENTIONS.md` §2.3).
 *
 * The scale axis is `size`, not `variant` (§2.10 — `variant` means emphasis),
 * and it uses §2.4a's TEXT ladder: `sm`/`md` are the control ladder's text sizes
 * so a paragraph sits on a control's baseline, and `lg` is the body step above
 * them. There is no `xs` row — it would duplicate `sm`.
 */
const sizes = {
	sm: { text: "text-xs", spacing: "mb-1.5" },
	md: { text: "text-sm", spacing: "mb-2" },
	lg: { text: "text-base", spacing: "mb-3" },
} as const;

// `ink`, not `tone`: `tone` is the semantic-status axis system-wide (§2.10).
const inks = {
	default: "text-ink",
	strong: "text-ink-strong",
	dimmed: "text-ink-dimmed",
	muted: "text-ink-muted",
} as const;

type ParagraphProps = React.ComponentPropsWithRef<"p"> & {
	size?: keyof typeof sizes;
	ink?: keyof typeof inks;
	/** Apply the size's bottom margin. Off by default. */
	spacing?: boolean;
};

export function Paragraph({ className, size = "md", ink = "default", spacing = false, ...props }: ParagraphProps) {
	return <p className={cn(sizes[size].text, inks[ink], spacing && sizes[size].spacing, className)} {...props} />;
}
