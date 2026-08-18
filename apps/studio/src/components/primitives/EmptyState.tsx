import { useCopy } from "@/components/primitives/CopyButton";
import { cn } from "@/lib/utils";

/**
 * Folded in from `shared/EmptyState.tsx` (§6): same name, same props, same
 * rendered text. Only the colors changed — every raw `zinc-*` / `blok-green-*`
 * became its semantic token, which is what the token guard is there to force.
 */
interface CodeSnippet {
	lang: string; // "curl · http", "typescript · sdk"
	code: string;
}

interface EmptyStateProps {
	icon: React.ReactNode;
	title: string;
	description: string | React.ReactNode;
	action?: React.ReactNode;
	className?: string;
	/**
	 * Empty states *teach*. When provided, snippets render below the description
	 * as monospace code blocks with copy-to-clipboard buttons.
	 */
	snippets?: CodeSnippet[];
	/** Anchor doc link rendered as a tertiary action below snippets. */
	docLink?: { href: string; label: string };
	/**
	 * Default `center` matches today's behavior. `left` is useful when the empty
	 * state is the *main content* of a page.
	 */
	align?: "center" | "left";
}

export function EmptyState({
	icon,
	title,
	description,
	action,
	className,
	snippets,
	docLink,
	align = "center",
}: EmptyStateProps) {
	const wrapperCls = cn(
		"flex flex-col py-12 px-4 max-w-2xl",
		align === "center" ? "items-center text-center mx-auto" : "items-start",
		className,
	);
	return (
		<div className={wrapperCls}>
			<div className={cn("mb-4 text-ink-muted", align === "center" && "opacity-60")}>{icon}</div>
			<h3 className="mb-1.5 font-display text-lg font-medium text-ink-strong italic tracking-tight">{title}</h3>
			<div className="mb-5 text-sm text-ink-dimmed leading-relaxed">{description}</div>

			{snippets && snippets.length > 0 && (
				<div className={cn("mb-5 w-full space-y-2.5", align === "center" && "text-left")}>
					{snippets.map((s) => (
						<Snippet key={s.lang} snippet={s} />
					))}
				</div>
			)}

			{(action || docLink) && (
				<div className="flex flex-wrap items-center gap-3">
					{action}
					{docLink && (
						<a
							href={docLink.href}
							target="_blank"
							rel="noreferrer noopener"
							className="focus-ring inline-flex items-center gap-1.5 rounded-md font-mono text-[12px] font-medium text-accent hover:text-accent-hover hover:underline"
						>
							↗ {docLink.label}
						</a>
					)}
				</div>
			)}
		</div>
	);
}

// One clipboard state machine in the design system, not two: `useCopy` already
// handles the missing-`navigator.clipboard` case (insecure context), carries an
// `error` state, and supplies the `aria-live` announcement. The bare boolean this
// used to hold silently swallowed a failed copy and announced nothing.
const copyLabels = { idle: "copy", copied: "copied", error: "copy failed" } as const;

const copyStyles = {
	idle: "border-line text-ink-dimmed hover:bg-hover hover:text-ink-strong",
	copied: "border-accent/30 bg-accent/15 text-accent",
	error: "border-status-failed/30 bg-status-failed/10 text-status-failed-ink",
} as const;

function Snippet({ snippet }: { snippet: CodeSnippet }) {
	const { copy, state, announcement } = useCopy(snippet.code);
	return (
		<div className="overflow-hidden rounded-md border border-line bg-overlay text-left">
			<div className="flex items-center gap-2 border-line border-b bg-canvas/40 px-3 py-1.5">
				<span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">{snippet.lang}</span>
				<button
					type="button"
					onClick={() => void copy()}
					className={cn(
						"focus-ring ml-auto rounded-md border px-2 py-0.5 font-mono text-[10.5px] transition-[color,background-color]",
						copyStyles[state],
					)}
				>
					{copyLabels[state]}
				</button>
				{/* Outside the button: inside, this would join its accessible name. */}
				<output aria-live="polite" className="sr-only select-none">
					{announcement}
				</output>
			</div>
			<pre className="overflow-x-auto whitespace-pre px-4 py-3 font-mono text-[11.5px] text-ink-strong leading-relaxed">
				{snippet.code}
			</pre>
		</div>
	);
}
