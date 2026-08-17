import { catalogPages } from "@/lib/catalogPages";
import { cn } from "@/lib/utils";
import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/catalog")({
	component: CatalogLayout,
});

function CatalogLayout() {
	return (
		<div className="flex h-full">
			<nav aria-label="Catalog" className="w-52 shrink-0 overflow-y-auto border-r border-line bg-canvas p-3">
				<h2 className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Catalog</h2>
				<ul className="space-y-0.5">
					{catalogPages.map(({ slug, label }) => (
						<li key={slug}>
							<Link
								to="/catalog/$page"
								params={{ page: slug }}
								className={cn(
									"focus-ring block rounded-md px-2.5 py-1.5 text-sm text-ink-dimmed transition-colors hover:bg-hover hover:text-ink",
								)}
								activeProps={{ className: "bg-accent/10 text-ink-strong" }}
							>
								{label}
							</Link>
						</li>
					))}
				</ul>
			</nav>
			<div className="flex-1 overflow-y-auto">
				<Outlet />
			</div>
		</div>
	);
}
