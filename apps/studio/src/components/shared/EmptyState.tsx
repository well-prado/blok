import { cn } from "@/lib/utils";
import { useState } from "react";

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
	 * Phase 6 redesign — empty states *teach*. When provided, snippets
	 * render below the description as monospace code blocks with
	 * copy-to-clipboard buttons. Designed for "No runs yet" → "here's
	 * a curl that creates one" guidance per the Direction A spec.
	 *
	 * The existing call sites pass only icon/title/description and keep
	 * working unchanged — this prop is purely additive.
	 */
	snippets?: CodeSnippet[];
	/**
	 * Anchor doc link rendered as a tertiary action below snippets.
	 * Brand-green text, ↗ glyph, opens in a new tab.
	 */
	docLink?: { href: string; label: string };
	/**
	 * Optional alignment override. Default `center` matches today's
	 * behavior (vertically + horizontally centered). `left` is useful
	 * when the empty state is the *main content* of a page (then we
	 * want to align with the page's grid, not float).
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
			<div className={cn("mb-4 text-zinc-600", align === "center" && "opacity-60")}>{icon}</div>
			<h3 className="text-lg font-medium text-zinc-100 mb-1.5 font-display italic tracking-tight">{title}</h3>
			<div className="text-sm text-zinc-400 leading-relaxed mb-5">{description}</div>

			{snippets && snippets.length > 0 && (
				<div className={cn("w-full space-y-2.5 mb-5", align === "center" && "text-left")}>
					{snippets.map((s) => (
						<Snippet key={s.lang} snippet={s} />
					))}
				</div>
			)}

			{(action || docLink) && (
				<div className="flex items-center gap-3 flex-wrap">
					{action}
					{docLink && (
						<a
							href={docLink.href}
							target="_blank"
							rel="noreferrer noopener"
							className="inline-flex items-center gap-1.5 text-[12px] text-blok-green-500 hover:text-blok-green-600 hover:underline font-mono font-medium"
						>
							↗ {docLink.label}
						</a>
					)}
				</div>
			)}
		</div>
	);
}

function Snippet({ snippet }: { snippet: CodeSnippet }) {
	const [copied, setCopied] = useState(false);
	const onCopy = async () => {
		try {
			await navigator.clipboard.writeText(snippet.code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard API can be denied (permissions) or absent (no-https
			// preview). Fall back gracefully — better than throwing.
		}
	};
	return (
		<div className="rounded-md border border-zinc-800 bg-overlay overflow-hidden text-left">
			<div className="px-3 py-1.5 bg-canvas/40 border-b border-zinc-800 flex items-center gap-2">
				<span className="font-mono text-[10px] uppercase tracking-[0.08em] text-zinc-500">{snippet.lang}</span>
				<button
					type="button"
					onClick={onCopy}
					className={cn(
						"ml-auto text-[10.5px] font-mono px-2 py-0.5 rounded border transition-colors",
						copied
							? "bg-blok-green-500/15 text-blok-green-500 border-blok-green-500/30"
							: "border-zinc-800 text-zinc-400 hover:bg-hover hover:text-zinc-100",
					)}
				>
					{copied ? "copied" : "copy"}
				</button>
			</div>
			<pre className="px-4 py-3 font-mono text-[11.5px] leading-relaxed text-zinc-100 overflow-x-auto whitespace-pre">
				{snippet.code}
			</pre>
		</div>
	);
}
