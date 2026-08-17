import { cn } from "@/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

/**
 * An inline link. One `href` prop, two renderings:
 *
 *   - a router-relative path (`/runs/123`, `#section`) → TanStack Router's
 *     `<Link>`, so it navigates in-app instead of reloading the SPA;
 *   - anything carrying a scheme (`https:`, `mailto:`) or protocol-relative
 *     (`//cdn…`) → a plain `<a>` with `target="_blank"`, `rel="noopener
 *     noreferrer"`, an icon affordance and a screen-reader announcement.
 *
 * Underlined on purpose: color alone is not a sufficient link cue (WCAG 1.4.1).
 * Size is inherited from the surrounding text — a link inside a `text-xs`
 * paragraph must not resize it — so there is no size prop.
 */
const variants = {
	primary: "text-accent hover:text-accent-hover",
	secondary: "text-ink-dimmed hover:text-ink",
} as const;

const base = "focus-ring inline-flex items-center gap-1 rounded-md underline underline-offset-2 transition-colors";

type TextLinkProps = React.ComponentPropsWithRef<"a"> & {
	href: string;
	variant?: keyof typeof variants;
};

/**
 * A scheme (`https:`, `mailto:`) or `//` means the URL leaves the router. Note
 * `mailto:` lands here too and picks up `target="_blank"`; that is deliberate —
 * handing it to `<Link>` would make the router try to navigate to it.
 */
const isExternal = (href: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);

export function TextLink({ href, className, variant = "primary", children, ...props }: TextLinkProps) {
	const classes = cn(base, variants[variant], className);
	const external = isExternal(href);
	// `useRouter` types its return as non-optional, but with `warn: false` it
	// really does return undefined outside a `RouterProvider` — which is exactly
	// the case worth detecting, since `<Link>` crashes there. A link that takes
	// down the page it is rendered on is not a link.
	const router: unknown = useRouter({ warn: false });

	if (external || !router) {
		return (
			<a href={href} className={classes} {...(external && { target: "_blank", rel: "noopener noreferrer" })} {...props}>
				{children}
				{external && (
					<>
						<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
						<span className="sr-only">(opens in a new tab)</span>
					</>
				)}
			</a>
		);
	}

	// ponytail: TanStack types `to` against the generated route tree, and an
	// `href` only known at runtime cannot be proven a member of it. Widened once
	// here rather than at every call site; the router 404s on a bad path anyway.
	return (
		<Link to={href as never} className={classes} {...props}>
			{children}
		</Link>
	);
}
