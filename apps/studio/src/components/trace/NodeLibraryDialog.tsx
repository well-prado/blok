import { useNodeCatalog } from "@/hooks/useWorkflows";
import type { NodeCatalogEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Loader2, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Phase 5.2 — the Node Library dialog, modeled on atomic-canvas's
 * NodeLibrary (NodeList + NodeDetails two-pane modal): type-to-search on
 * the left, select a node to read its description and input schema on the
 * right, confirm with Add node. Fed by `GET /__blok/nodes`.
 */

export interface NodeLibraryDialogProps {
	open: boolean;
	/** Where the insert will land, e.g. "Inserts after fill-email". */
	insertHint: string;
	pending: boolean;
	error?: string;
	onAdd: (entry: NodeCatalogEntry) => void;
	onClose: () => void;
}

function groupOf(entry: NodeCatalogEntry): string {
	if (entry.ref.startsWith("runtime.")) return entry.ref.slice("runtime.".length, entry.ref.indexOf(":"));
	if (entry.ref.startsWith("@blokjs/")) return "@blokjs";
	return "project";
}

interface SchemaPropertyRow {
	name: string;
	type: string;
	required: boolean;
	description?: string;
}

function schemaRows(schema: unknown): SchemaPropertyRow[] {
	const s = (schema ?? {}) as {
		properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
		required?: string[];
	};
	const required = new Set(s.required ?? []);
	return Object.entries(s.properties ?? {}).map(([name, prop]) => ({
		name,
		type: Array.isArray(prop?.enum) ? prop.enum.map(String).join(" | ") : (prop?.type ?? "any"),
		required: required.has(name),
		description: prop?.description,
	}));
}

export function NodeLibraryDialog({ open, insertHint, pending, error, onAdd, onClose }: NodeLibraryDialogProps) {
	const catalog = useNodeCatalog(open);
	const [search, setSearch] = useState("");
	const [group, setGroup] = useState<string | null>(null);
	const [selectedRef, setSelectedRef] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	const nodes = catalog.data?.nodes ?? [];
	const groups = useMemo(() => [...new Set(nodes.map(groupOf))].sort(), [nodes]);
	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return nodes.filter((entry) => {
			if (group && groupOf(entry) !== group) return false;
			if (!q) return true;
			return `${entry.ref} ${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(q);
		});
	}, [nodes, search, group]);
	const selected = useMemo(
		() => filtered.find((entry) => entry.ref === selectedRef) ?? filtered[0],
		[filtered, selectedRef],
	);

	if (!open) return null;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close mirrors the Escape handler above
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
			onClick={onClose}
			role="presentation"
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops backdrop propagation; Escape still closes */}
			<dialog
				open
				aria-label="Node library"
				className="relative m-0 flex h-[520px] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-[#131316] p-0 text-left shadow-2xl shadow-black/50"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
					<span className="text-sm font-semibold text-zinc-100">Add a node</span>
					<span className="text-[11px] text-zinc-500">{insertHint}</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close node library"
						className="ml-auto rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					<div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
						<div className="space-y-2 border-b border-zinc-800 p-3">
							<div className="relative">
								<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
								<input
									aria-label="Search nodes"
									placeholder="Search nodes…"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									// biome-ignore lint/a11y/noAutofocus: focus follows the explicit Add step action
									autoFocus
									spellCheck={false}
									className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-7 pr-2 text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-blok-green-400"
								/>
							</div>
							<div className="flex flex-wrap gap-1">
								<button
									type="button"
									onClick={() => setGroup(null)}
									className={cn(
										"rounded-full border px-2 py-0.5 text-[10px]",
										group === null
											? "border-blok-green-500/60 bg-blok-green-500/10 text-blok-green-300"
											: "border-zinc-700 text-zinc-400 hover:text-zinc-200",
									)}
								>
									All
								</button>
								{groups.map((g) => (
									<button
										type="button"
										key={g}
										onClick={() => setGroup((current) => (current === g ? null : g))}
										className={cn(
											"rounded-full border px-2 py-0.5 font-mono text-[10px]",
											group === g
												? "border-blok-green-500/60 bg-blok-green-500/10 text-blok-green-300"
												: "border-zinc-700 text-zinc-400 hover:text-zinc-200",
										)}
									>
										{g}
									</button>
								))}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto p-2">
							{catalog.isLoading && <p className="p-2 text-xs text-zinc-500">Loading node catalog…</p>}
							{catalog.error && <p className="p-2 text-xs text-red-300">{catalog.error.message}</p>}
							<ul className="space-y-0.5">
								{filtered.map((entry) => (
									<li key={entry.ref}>
										<button
											type="button"
											onClick={() => setSelectedRef(entry.ref)}
											onDoubleClick={() => onAdd(entry)}
											className={cn(
												"w-full rounded-md px-2 py-1.5 text-left hover:bg-zinc-800/70",
												selected?.ref === entry.ref && "bg-zinc-800",
											)}
										>
											<span className="block truncate font-mono text-xs text-zinc-200">{entry.name}</span>
											<span className="block truncate text-[10px] text-zinc-500">{entry.description || entry.ref}</span>
										</button>
									</li>
								))}
								{!catalog.isLoading && filtered.length === 0 && (
									<li className="p-2 text-xs text-zinc-500">No nodes match.</li>
								)}
							</ul>
						</div>
					</div>
					<div className="flex min-h-0 flex-1 flex-col">
						{selected ? (
							<>
								<div className="min-h-0 flex-1 overflow-y-auto p-4">
									<h3 className="font-mono text-sm font-semibold text-zinc-100">{selected.name}</h3>
									<p className="mt-0.5 font-mono text-[10px] text-zinc-500">{selected.ref}</p>
									{selected.description && <p className="mt-3 text-xs text-zinc-300">{selected.description}</p>}
									{schemaRows(selected.inputSchema).length > 0 && (
										<div className="mt-4">
											<h4 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Inputs</h4>
											<ul className="mt-1.5 space-y-1">
												{schemaRows(selected.inputSchema).map((row) => (
													<li key={row.name} className="flex items-baseline gap-2 text-xs">
														<span className="font-mono text-zinc-200">{row.name}</span>
														{row.required && <span className="text-[10px] text-amber-300">required</span>}
														<span className="truncate font-mono text-[10px] text-zinc-500" title={row.description}>
															{row.type}
														</span>
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
								<div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
									{error && <span className="truncate text-xs text-red-300">{error}</span>}
									<button
										type="button"
										onClick={() => onAdd(selected)}
										disabled={pending}
										className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blok-green-500 px-3 py-1.5 text-xs font-semibold text-[#00231b] hover:bg-blok-green-600 disabled:cursor-not-allowed disabled:opacity-40"
									>
										{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
										Add node
									</button>
								</div>
							</>
						) : (
							<p className="p-4 text-xs text-zinc-500">Select a node to see its details.</p>
						)}
					</div>
				</div>
			</dialog>
		</div>
	);
}
