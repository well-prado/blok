import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  type ColumnDef,
  flexRender,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, formatRelativeTime } from "@/lib/formatters";
import { StatusBadge } from "@/components/shared/StatusBadge";
import type { WorkflowRun } from "@/types";

interface RunsTableProps {
  runs: WorkflowRun[];
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
  showWorkflow?: boolean;
}

export function RunsTable({ runs, total, page, limit, onPageChange, showWorkflow = false }: RunsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<WorkflowRun>[]>(() => {
    const cols: ColumnDef<WorkflowRun>[] = [];

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
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        size: 120,
      },
      {
        accessorKey: "triggerSummary",
        header: "Trigger",
        cell: ({ row }) => (
          <span className="text-xs text-zinc-400 font-mono">
            {row.original.triggerSummary}
          </span>
        ),
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
        cell: ({ row }) => (
          <span className="text-xs text-zinc-500">
            {formatRelativeTime(row.original.startedAt)}
          </span>
        ),
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
  }, [showWorkflow]);

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
                className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2.5">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: row.original.id }}
                      className="block"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Link>
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
