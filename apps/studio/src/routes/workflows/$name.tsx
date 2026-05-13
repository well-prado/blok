import { RunFilters } from "@/components/runs/RunFilters";
import { RunsTable } from "@/components/runs/RunsTable";
import { EmptyState } from "@/components/shared/EmptyState";
import { ExportMenu } from "@/components/shared/ExportMenu";
import { JsonViewer } from "@/components/shared/JsonViewer";
import { RoutingDiagnosticsBanner } from "@/components/shared/RoutingDiagnosticsBanner";
import { WorkflowGraph } from "@/components/trace/WorkflowGraph";
import { useWorkflowRuns } from "@/hooks/useRuns";
import { useWorkflowDetail } from "@/hooks/useWorkflows";
import { exportRunsCsv, exportRunsJson } from "@/lib/api";
import { formatDuration, formatPercent } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, GitBranch, Loader2, Workflow } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/workflows/$name")({
	component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
	const { name } = Route.useParams();
	const [statusFilter, setStatusFilter] = useState("");
	const [page, setPage] = useState(1);
	const [activeTab, setActiveTab] = useState<"runs" | "graph" | "definition" | "metrics">("runs");
	const limit = 25;

	const { data: detail, isLoading: detailLoading } = useWorkflowDetail(name);
	const { data: runsData, isLoading: runsLoading } = useWorkflowRuns(name, {
		status: statusFilter || undefined,
		limit,
		offset: (page - 1) * limit,
	});

	if (detailLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
			</div>
		);
	}

	if (!detail) {
		return (
			<div className="p-8">
				<EmptyState
					icon={<Workflow className="w-10 h-10" />}
					title="Workflow not found"
					description={
						<>
							No workflow named
							<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
								{name}
							</code>
							is registered. Workflows live in
							<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
								triggers/http/src/workflows/
							</code>
							and are discovered on trigger startup. Did you commit the file but forget to restart the dev orchestrator?
						</>
					}
				/>
			</div>
		);
	}

	const tabs = [
		{ key: "runs" as const, label: "Runs" },
		{ key: "graph" as const, label: "Graph" },
		{ key: "definition" as const, label: "Definition" },
		{ key: "metrics" as const, label: "Metrics" },
	];

	return (
		<div className="p-6 max-w-7xl mx-auto space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<Link to="/" className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
					<ArrowLeft className="w-4 h-4" />
				</Link>
				<div>
					<h1 className="text-lg font-semibold text-zinc-100">{name}</h1>
					<p className="text-sm text-zinc-500">
						{detail.triggerTypes.join(", ")} &middot; {detail.totalRuns} runs &middot; avg{" "}
						{formatDuration(detail.avgDurationMs)} &middot; {formatPercent(detail.errorRate)} errors
					</p>
				</div>
			</div>

			{/* Routing diagnostics — boot-time route-build problems
			    surfaced from `/__blok/routing`. Stays out of the way
			    when there's nothing to report. */}
			<RoutingDiagnosticsBanner />

			{/* Tabs */}
			<div className="flex gap-0 border-b border-zinc-800">
				{tabs.map((tab) => (
					<button
						type="button"
						key={tab.key}
						onClick={() => setActiveTab(tab.key)}
						className={cn(
							"px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
							activeTab === tab.key
								? "border-blok-green-500 text-zinc-100"
								: "border-transparent text-zinc-500 hover:text-zinc-300",
						)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Tab content */}
			{activeTab === "runs" && (
				<div className="space-y-3">
					<div className="flex items-center gap-3">
						<div className="flex-1">
							<RunFilters status={statusFilter} onStatusChange={setStatusFilter} />
						</div>
						<ExportMenu
							onExportJson={() => exportRunsJson({ workflow: name, status: statusFilter || undefined })}
							onExportCsv={() => exportRunsCsv({ workflow: name, status: statusFilter || undefined })}
							label="Export All"
						/>
					</div>
					{runsLoading ? (
						<div className="flex justify-center py-8">
							<Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
						</div>
					) : runsData && runsData.runs.length > 0 ? (
						<RunsTable
							runs={runsData.runs}
							total={runsData.total}
							page={page}
							limit={limit}
							onPageChange={setPage}
							enableCompare
						/>
					) : statusFilter ? (
						<EmptyState
							icon={<Workflow className="w-10 h-10" />}
							title={`No ${statusFilter} runs match`}
							description={`Across the loaded window, none of ${detail.name}'s runs have status "${statusFilter}". Either it's been quiet or the filter is too tight.`}
							action={
								<button
									type="button"
									onClick={() => setStatusFilter("")}
									className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blok-green-500 text-[#00231b] hover:bg-blok-green-600 transition-colors"
								>
									Clear filter
								</button>
							}
						/>
					) : (
						<EmptyState
							icon={<Workflow className="w-10 h-10" />}
							title="No runs yet"
							description={
								<>
									This workflow exists but hasn't been triggered. Try the curl below — it'll exercise the
									<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
										{detail.name}
									</code>
									path end-to-end.
								</>
							}
							snippets={[
								{
									lang: curlLabel(detail.examples?.source),
									code: buildCurlSnippet(detail),
								},
							]}
						/>
					)}
				</div>
			)}

			{activeTab === "graph" &&
				(detail.definition ? (
					<WorkflowGraph definition={detail.definition} />
				) : (
					<EmptyState
						icon={<GitBranch className="w-10 h-10" />}
						title="Definition unavailable"
						description={
							<>
								Studio reads the workflow structure from the runner's in-process registry. Either the runner hasn't
								registered this workflow yet (restart the trigger to rescan) or it's an older deployment that predates
								the
								<code className="font-mono text-[12px] bg-raised border border-zinc-800 rounded px-1.5 py-0.5 mx-1 text-zinc-100">
									GET /__blok/workflows/:name → definition
								</code>
								surface. The "Definition" tab still shows what we know.
							</>
						}
					/>
				))}

			{activeTab === "definition" && (
				<div className="rounded-lg border border-zinc-800 bg-overlay p-4">
					<JsonViewer data={detail.definition || { nodeNames: detail.nodeNames, runtimes: detail.runtimes }} />
				</div>
			)}

			{activeTab === "metrics" && (
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
					<MetricCard label="Total Runs" value={String(detail.totalRuns)} />
					<MetricCard label="Recent (24h)" value={String(detail.recentRuns)} />
					<MetricCard label="Avg Duration" value={formatDuration(detail.avgDurationMs)} />
					<MetricCard label="P95 Duration" value={formatDuration(detail.p95DurationMs)} />
					<MetricCard label="Error Rate" value={formatPercent(detail.errorRate)} />
					<MetricCard label="Runtimes" value={detail.runtimes.join(", ") || "—"} />
					<MetricCard label="Nodes" value={String(detail.nodeNames.length)} />
					<MetricCard label="Triggers" value={detail.triggerTypes.join(", ")} />
				</div>
			)}
		</div>
	);
}

function MetricCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-zinc-800 bg-overlay p-4">
			<div className="text-xs text-zinc-500 mb-1">{label}</div>
			<div className="text-lg font-semibold text-zinc-100 font-mono">{value}</div>
		</div>
	);
}

/**
 * Pick a clearer language label per body provenance. Authors who
 * declared an explicit `trigger.http.examples.body` get a callout
 * that their example body is in use; operators who opted into
 * `recordSample` see the "(recorded)" tag so they know the curl
 * came from a real successful run. Static inference + empty stay
 * unlabelled — they're the default heuristic state.
 */
function curlLabel(source: "author" | "recorded" | "inferred" | "empty" | undefined): string {
	if (source === "author") return "curl · http (example body)";
	if (source === "recorded") return "curl · http (recorded body)";
	return "curl · http";
}

/**
 * Build the empty-state curl example. The body is `detail.examples.body`
 * (server-side inferred / recorded / author-declared); the method + path
 * come from the workflow definition's `trigger.http` config; the host
 * defaults to the dev orchestrator's `http://localhost:4000`. Falls
 * back to a sensible POST / `${name}` / `{}` shape when the definition
 * is unavailable (legacy deployments where the registry didn't seed
 * the detail endpoint).
 */
function buildCurlSnippet(detail: WorkflowDetailLike): string {
	const trigger = readHttpTrigger(detail.definition);
	const method = (trigger?.method ?? "POST").toUpperCase();
	const path = trigger?.path ?? detail.path ?? `/${detail.name}`;
	const url = `http://localhost:4000${path.startsWith("/") ? path : `/${path}`}`;
	if (method === "GET" || method === "HEAD" || method === "DELETE") {
		// Body-less methods — keep the command terse.
		return `curl -X ${method} ${url}`;
	}
	const body = JSON.stringify(detail.examples?.body ?? {}, null, 2);
	return `curl -X ${method} ${url} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

function readHttpTrigger(definition: unknown): { method?: string; path?: string } | null {
	if (!definition || typeof definition !== "object") return null;
	const trigger = (definition as { trigger?: unknown }).trigger;
	if (!trigger || typeof trigger !== "object") return null;
	const http = (trigger as { http?: unknown }).http;
	if (!http || typeof http !== "object") return null;
	const cfg = http as { method?: unknown; path?: unknown };
	return {
		method: typeof cfg.method === "string" ? cfg.method : undefined,
		path: typeof cfg.path === "string" ? cfg.path : undefined,
	};
}

/**
 * Local structural type narrowing the WorkflowDetail to the fields
 * `buildCurlSnippet` reads. Avoids re-importing the global type with
 * the new `examples` field everywhere a curl-snippet helper might
 * want to live.
 */
interface WorkflowDetailLike {
	name: string;
	path?: string;
	definition?: unknown;
	examples?: { body: unknown; source: "author" | "recorded" | "inferred" | "empty" };
}
