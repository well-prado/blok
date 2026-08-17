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

const tones = {
	strong: "text-ink-strong",
	dimmed: "text-ink-dimmed",
} as const;

type HeaderProps = React.ComponentPropsWithRef<"h1"> & {
	/** Apply the variant's bottom margin. Off by default. */
	spacing?: boolean;
	tone?: keyof typeof tones;
};

function headerClass(level: keyof typeof headers, tone: keyof typeof tones, spacing: boolean, className?: string) {
	return cn(headers[level].text, tones[tone], spacing && headers[level].spacing, className);
}

export function Header1({ className, spacing = false, tone = "strong", ...props }: HeaderProps) {
	return <h1 className={headerClass("h1", tone, spacing, className)} {...props} />;
}

export function Header2({ className, spacing = false, tone = "strong", ...props }: HeaderProps) {
	return <h2 className={headerClass("h2", tone, spacing, className)} {...props} />;
}

export function Header3({ className, spacing = false, tone = "strong", ...props }: HeaderProps) {
	return <h3 className={headerClass("h3", tone, spacing, className)} {...props} />;
}
