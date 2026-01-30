import { StatusBadge } from "@/components/shared/StatusBadge";
import { formatDuration, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { WorkflowRun } from "@/types";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	type ColumnDef,
	type SortingState,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronLeft, ChevronRight, GitCompareArrows } from "lucide-react";
import { useMemo, useState } from "react";

interface RunsTableProps {
	runs: WorkflowRun[];
	total: number;
	page: number;
	limit: number;
	onPageChange: (page: number) => void;
	showWorkflow?: boolean;
	enableCompare?: boolean;
}

export function RunsTable({
	runs,
	total,
	page,
	limit,
	onPageChange,
	showWorkflow = false,
	enableCompare = false,
}: RunsTableProps) {
	const navigate = useNavigate();
	const [sorting, setSorting] = useState<SortingState>([]);
	const [compareSelection, setCompareSelection] = useState<string[]>([]);

	const handleCompare = () => {
		if (compareSelection.length === 2) {
			navigate({
				to: "/runs/diff",
				search: { a: compareSelection[0], b: compareSelection[1] },
			});
		}
	};

	const columns = useMemo<ColumnDef<WorkflowRun>[]>(() => {
		const cols: ColumnDef<WorkflowRun>[] = [];

		if (enableCompare) {
			cols.push({
				id: "compare",
				header: "",
				cell: ({ row }) => {
					const isSelected = compareSelection.includes(row.original.id);
					return (
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setCompareSelection((prev) => {
									if (prev.includes(row.original.id)) return prev.filter((id) => id !== row.original.id);
									if (prev.length >= 2) return [prev[1] ?? prev[0], row.original.id].filter(Boolean) as string[];
									return [...prev, row.original.id];
								});
							}}
							className={cn(
								"w-4 h-4 rounded border transition-colors shrink-0",
								isSelected ? "bg-blue-500 border-blue-500" : "border-zinc-600 hover:border-zinc-400",
							)}
							title="Select for comparison"
						/>
					);
				},
				size: 40,
			});
		}

		if (showWorkflow) {
			cols.push({
				accessorKey: "workflowName",
				header: "Workflow",
				cell: ({ row }) => (
					<Link
						to="/workflows/$name"
						params={{ name: row.original.workflowName }}
						className="text-zinc-200 hover:text-white font-medium"
						onClick={(e) => e.stopPropagation()}
					>
						{row.original.workflowName}
					</Link>
				),
			});
		}

		cols.push(
			{
				accessorKey: "status",
				header: "Status",
				cell: ({ row }) => (
					<div className="flex items-center gap-1.5">
						<StatusBadge status={row.original.status} />
						{row.original.tags && row.original.tags.length > 0 && (
							<div className="flex gap-1">
								{row.original.tags.slice(0, 2).map((tag) => (
									<span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400">
										{tag}
									</span>
								))}
								{row.original.tags.length > 2 && (
									<span className="text-[10px] text-zinc-600">+{row.original.tags.length - 2}</span>
								)}
							</div>
						)}
					</div>
				),
				size: 160,
			},
			{
				accessorKey: "triggerSummary",
				header: "Trigger",
				cell: ({ row }) => <span className="text-xs text-zinc-400 font-mono">{row.original.triggerSummary}</span>,
			},
			{
				accessorKey: "durationMs",
				header: "Duration",
				cell: ({ row }) => (
					<span className="text-xs font-mono text-zinc-300">
						{row.original.status === "running" ? (
							<span className="text-blue-400">running...</span>
						) : (
							formatDuration(row.original.durationMs)
						)}
					</span>
				),
				size: 100,
			},
			{
				accessorKey: "startedAt",
				header: "Started",
				cell: ({ row }) => <span className="text-xs text-zinc-500">{formatRelativeTime(row.original.startedAt)}</span>,
				size: 100,
			},
			{
				id: "progress",
				header: "Nodes",
				cell: ({ row }) => (
					<span className="text-xs font-mono text-zinc-400">
						{row.original.completedNodes}/{row.original.nodeCount}
					</span>
				),
				size: 80,
			},
		);

		return cols;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showWorkflow, enableCompare, compareSelection]);

	const table = useReactTable({
		data: runs,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	const totalPages = Math.ceil(total / limit);

	return (
		<div>
			{/* Compare bar */}
			{enableCompare && compareSelection.length > 0 && (
				<div className="mb-3 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
					<GitCompareArrows className="w-4 h-4 text-zinc-500" />
					<span className="text-xs text-zinc-400">{compareSelection.length}/2 runs selected</span>
					{compareSelection.length === 2 && (
						<button
							type="button"
							onClick={handleCompare}
							className="ml-auto text-xs font-medium px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-500 transition-colors"
						>
							Compare
						</button>
					)}
					<button
						type="button"
						onClick={() => setCompareSelection([])}
						className={cn(
							"text-xs text-zinc-500 hover:text-zinc-300 transition-colors",
							compareSelection.length === 2 ? "" : "ml-auto",
						)}
					>
						Clear
					</button>
				</div>
			)}

			<div className="rounded-lg border border-zinc-800 overflow-hidden">
				<table className="w-full text-sm">
					<thead>
						{table.getHeaderGroups().map((headerGroup) => (
							<tr key={headerGroup.id} className="border-b border-zinc-800 bg-zinc-900/50">
								{headerGroup.headers.map((header) => (
									<th
										key={header.id}
										className="text-left px-3 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wider"
										style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
									>
										{header.isPlaceholder ? null : (
											<button
												type="button"
												className="flex items-center gap-1 hover:text-zinc-300 transition-colors"
												onClick={header.column.getToggleSortingHandler()}
											>
												{flexRender(header.column.columnDef.header, header.getContext())}
												<ArrowUpDown className="w-3 h-3" />
											</button>
										)}
									</th>
								))}
							</tr>
						))}
					</thead>
					<tbody>
						{table.getRowModel().rows.map((row) => (
							<tr
								key={row.id}
								className={cn(
									"border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer",
									compareSelection.includes(row.original.id) && "bg-blue-500/5",
								)}
							>
								{row.getVisibleCells().map((cell) => (
									<td key={cell.id} className="px-3 py-2.5">
										{cell.column.id === "compare" ? (
											flexRender(cell.column.columnDef.cell, cell.getContext())
										) : (
											<Link to="/runs/$runId" params={{ runId: row.original.id }} className="block">
												{flexRender(cell.column.columnDef.cell, cell.getContext())}
											</Link>
										)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Pagination */}
			{totalPages > 1 && (
				<div className="flex items-center justify-between mt-3 text-sm">
					<span className="text-zinc-500 text-xs">
						{total} total run{total !== 1 ? "s" : ""}
					</span>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => onPageChange(page - 1)}
							disabled={page <= 1}
							className={cn(
								"p-1 rounded hover:bg-zinc-800 transition-colors",
								page <= 1 ? "text-zinc-700 cursor-not-allowed" : "text-zinc-400",
							)}
						>
							<ChevronLeft className="w-4 h-4" />
						</button>
						<span className="text-xs text-zinc-400">
							Page {page} of {totalPages}
						</span>
						<button
							type="button"
							onClick={() => onPageChange(page + 1)}
							disabled={page >= totalPages}
							className={cn(
								"p-1 rounded hover:bg-zinc-800 transition-colors",
								page >= totalPages ? "text-zinc-700 cursor-not-allowed" : "text-zinc-400",
							)}
						>
							<ChevronRight className="w-4 h-4" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
