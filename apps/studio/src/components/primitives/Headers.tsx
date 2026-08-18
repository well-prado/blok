import { cn } from "@/lib/utils";

/**
 * The heading scale. Three components, not a `level` prop: the tag IS the API,
 * so a screen reader's heading outline and the source read the same
 * (`_design/CONVENTIONS.md` §12.2).
 *
 * Zero margin by default — `spacing` is opt-in (§2.3), because a primitive must
 * never fight its container's layout.
 */
const headers = {
	h1: { text: "text-2xl font-semibold tracking-tight", spacing: "mb-2" },
	h2: { text: "text-base font-semibold tracking-tight", spacing: "mb-2" },
	h3: { text: "text-sm font-semibold", spacing: "mb-2" },
} as const;

// The prop is `ink`, not `tone` (§2.10): `tone` means semantic status system-wide,
// and a heading's color is text weight, not a status. The keys are the ink token
// names with the `ink-` prefix dropped.
const inks = {
	strong: "text-ink-strong",
	dimmed: "text-ink-dimmed",
} as const;

type HeaderProps = React.ComponentPropsWithRef<"h1"> & {
	/** Apply the level's bottom margin. Off by default. */
	spacing?: boolean;
	ink?: keyof typeof inks;
};

function headerClass(level: keyof typeof headers, ink: keyof typeof inks, spacing: boolean, className?: string) {
	return cn(headers[level].text, inks[ink], spacing && headers[level].spacing, className);
}

export function Header1({ className, spacing = false, ink = "strong", ...props }: HeaderProps) {
	return <h1 className={headerClass("h1", ink, spacing, className)} {...props} />;
}

export function Header2({ className, spacing = false, ink = "strong", ...props }: HeaderProps) {
	return <h2 className={headerClass("h2", ink, spacing, className)} {...props} />;
}

export function Header3({ className, spacing = false, ink = "strong", ...props }: HeaderProps) {
	return <h3 className={headerClass("h3", ink, spacing, className)} {...props} />;
}
