import type { ReactNode } from "react";

/**
 * The shared scaffold every catalog page renders inside. It exists so the
 * catalog does not drift the way trigger.dev's 51 hand-rolled storybook routes
 * did (padding varies p-4/p-8/p-12, some pages have no heading at all).
 *
 * Page authors get two components and no layout decisions.
 */
export function CatalogPage({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<div className="p-8">
			<header className="mb-8 border-b border-line pb-4">
				<h1 className="text-xl font-semibold text-ink-strong">{title}</h1>
				{description && <p className="mt-1 max-w-prose text-sm text-ink-dimmed">{description}</p>}
			</header>
			<div className="space-y-8">{children}</div>
		</div>
	);
}

/** One axis of variation: variants, sizes, states. One `<Variant>` per axis. */
export function Variant({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section>
			<h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{label}</h2>
			<div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-raised p-4">{children}</div>
		</section>
	);
}
