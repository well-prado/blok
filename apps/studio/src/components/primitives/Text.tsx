import { cn } from "@/lib/utils";

/**
 * Inline text on §2.4a's TEXT ladder, with the two flags a data grid needs.
 *
 * Assigned to E1-T4 by `_design/CONVENTIONS.md` §12.1 and never shipped; built
 * here by E2-T1 because table cells need monospace and tabular numerals and
 * nothing else in the system provides them (§2.17, §12.1 correction).
 *
 * Two orthogonal tables, exactly like `Paragraph.tsx` — this IS that component
 * with a `<span>` and two booleans.
 *
 * No `variant` and no `tone`: scale is `size`, color is `ink` (§2.10 rules 2
 * and 3). No `spacing` either — it is inline text, not a block (§2.3).
 */
const sizes = {
	sm: "text-xs",
	md: "text-sm",
	lg: "text-base",
} as const;

// `inks`, not `tones` — §2.10 rule 5 names a private table for its axis.
const inks = {
	default: "text-ink",
	strong: "text-ink-strong",
	dimmed: "text-ink-dimmed",
	muted: "text-ink-muted",
} as const;

type TextProps = React.ComponentPropsWithRef<"span"> & {
	size?: keyof typeof sizes;
	ink?: keyof typeof inks;
	/** `font-mono` — ids, hashes, payload keys. Independent of `numeric`. */
	mono?: boolean;
	/** `tabular-nums` — MANDATORY on every column of numbers (§2.11). */
	numeric?: boolean;
};

export function Text({ className, size = "md", ink = "default", mono = false, numeric = false, ...props }: TextProps) {
	return (
		<span
			className={cn(sizes[size], inks[ink], mono && "font-mono", numeric && "tabular-nums", className)}
			{...props}
		/>
	);
}
