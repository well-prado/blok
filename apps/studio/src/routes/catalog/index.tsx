import { catalogPages } from "@/lib/catalogPages";
import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/catalog/")({
	component: CatalogIndex,
});

function CatalogIndex() {
	return (
		<div className="p-8">
			<h1 className="text-xl font-semibold text-ink-strong">Design system catalog</h1>
			<p className="mt-2 max-w-prose text-sm text-ink-dimmed">
				Every Studio primitive, every variant, every state. Pages are discovered from{" "}
				<code className="font-mono text-xs text-ink">src/catalog/*.tsx</code> — add a file with a default export and it
				shows up here.
			</p>
			<ul className="mt-6 space-y-1">
				{catalogPages.map(({ slug, label }) => (
					<li key={slug}>
						<Link
							to="/catalog/$page"
							params={{ page: slug }}
							className="focus-ring text-sm text-accent hover:text-accent-hover"
						>
							{label}
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
