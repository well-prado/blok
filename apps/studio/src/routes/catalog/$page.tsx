import { Spinner } from "@/components/primitives/Spinner";
import { catalogPages } from "@/lib/catalogPages";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy, useMemo } from "react";

export const Route = createFileRoute("/catalog/$page")({
	component: CatalogPageRoute,
});

function CatalogPageRoute() {
	const { page } = Route.useParams();
	const entry = catalogPages.find((p) => p.slug === page);

	const Page = useMemo(() => (entry ? lazy(entry.load) : null), [entry]);

	if (!Page) {
		return (
			<div className="p-8">
				<h1 className="text-xl font-semibold text-ink-strong">No catalog page “{page}”</h1>
				<p className="mt-2 text-sm text-ink-dimmed">
					Add <code className="font-mono text-xs text-ink">src/catalog/{page}.tsx</code> with a default export.
				</p>
			</div>
		);
	}

	return (
		<Suspense
			fallback={
				<div className="flex items-center gap-2 p-8 text-sm text-ink-muted">
					<Spinner /> Loading…
				</div>
			}
		>
			<Page />
		</Suspense>
	);
}
