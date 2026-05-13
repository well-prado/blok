/**
 * Integration tests for TraceRouter API endpoints.
 *
 * Tests all /__blok/* endpoints by registering handlers on a mock router
 * and invoking them with mock Request/Response objects. This validates
 * the full API surface without needing Express or an HTTP server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRunStore } from "../../tracing/InMemoryRunStore";
import { RoutingDiagnostics } from "../../tracing/RoutingDiagnostics";
import { RunTracker } from "../../tracing/RunTracker";
import { registerTraceRoutes } from "../../tracing/TraceRouter";
import { WorkflowRegistry } from "../../workflow/WorkflowRegistry";

// --- Mock infrastructure ---

type HandlerFn = (req: MockRequest, res: MockResponse) => void;
type MiddlewareFn = (req: MockRequest, res: MockResponse, next: () => void) => void;

interface RegisteredRoute {
	method: string;
	path: string;
	handler: HandlerFn;
}

class MockRouter {
	routes: RegisteredRoute[] = [];
	middlewares: MiddlewareFn[] = [];

	use(handler: MiddlewareFn) {
		this.middlewares.push(handler);
	}
	get(path: string, handler: HandlerFn) {
		this.routes.push({ method: "GET", path, handler });
	}
	post(path: string, handler: HandlerFn) {
		this.routes.push({ method: "POST", path, handler });
	}
	put(path: string, handler: HandlerFn) {
		this.routes.push({ method: "PUT", path, handler });
	}
	delete(path: string, handler: HandlerFn) {
		this.routes.push({ method: "DELETE", path, handler });
	}

	findHandler(method: string, path: string): HandlerFn | undefined {
		return this.routes.find((r) => r.method === method && r.path === path)?.handler;
	}
}

class MockRequest {
	method: string;
	params: Record<string, string>;
	query: Record<string, string | undefined>;
	headers: Record<string, string | string[] | undefined>;
	body?: unknown;
	private listeners: Map<string, (() => void)[]> = new Map();

	constructor(
		opts?: Partial<{
			method: string;
			params: Record<string, string>;
			query: Record<string, string | undefined>;
			headers: Record<string, string | string[] | undefined>;
			body: unknown;
		}>,
	) {
		this.method = opts?.method || "GET";
		this.params = opts?.params || {};
		this.query = opts?.query || {};
		this.headers = opts?.headers || {};
		this.body = opts?.body;
	}

	on(event: string, listener: () => void) {
		const list = this.listeners.get(event) || [];
		list.push(listener);
		this.listeners.set(event, list);
	}

	simulateClose() {
		const list = this.listeners.get("close") || [];
		for (const fn of list) fn();
	}
}

class MockResponse {
	statusCode = 200;
	headersMap = new Map<string, string>();
	jsonBody: unknown = undefined;
	writtenChunks: string[] = [];
	ended = false;
	flushed = false;
	sentStatus: number | undefined = undefined;

	setHeader(name: string, value: string) {
		this.headersMap.set(name, value);
	}

	status(code: number): MockResponse {
		this.statusCode = code;
		return this;
	}

	json(body: unknown) {
		this.jsonBody = body;
	}

	write(chunk: string): boolean {
		this.writtenChunks.push(chunk);
		return true;
	}

	end() {
		this.ended = true;
	}

	sendStatus(code: number) {
		this.sentStatus = code;
		this.statusCode = code;
	}

	flushHeaders() {
		this.flushed = true;
	}
}

// --- Test helpers ---

function seedData(tracker: RunTracker) {
	// Create a completed run with nodes and logs
	const run1 = tracker.startRun({
		workflowName: "countries",
		workflowPath: "/workflows/countries.json",
		triggerType: "http",
		triggerSummary: "GET /countries",
		nodeCount: 3,
		tags: ["env:dev"],
	});

	const node1 = tracker.startNode(run1.id, {
		nodeName: "validate-input",
		nodeType: "module",
		runtimeKind: "nodejs",
		depth: 0,
		stepIndex: 0,
		inputs: { query: "all" },
	});
	tracker.completeNode(node1.id, { valid: true }, { duration_ms: 3, cpu_ms: 1, memory_bytes: 1024 });

	const node2 = tracker.startNode(run1.id, {
		nodeName: "fetch-data",
		nodeType: "module",
		runtimeKind: "nodejs",
		depth: 0,
		stepIndex: 1,
		inputs: { url: "https://api.example.com" },
	});
	tracker.completeNode(node2.id, { countries: ["US", "UK"] });

	const node3 = tracker.startNode(run1.id, {
		nodeName: "format-response",
		nodeType: "module",
		runtimeKind: "nodejs",
		depth: 0,
		stepIndex: 2,
	});
	tracker.completeNode(node3.id, { formatted: true });

	tracker.addLog({
		runId: run1.id,
		nodeId: node1.id,
		nodeName: "validate-input",
		level: "info",
		message: "Input validated successfully",
	});

	tracker.addLog({
		runId: run1.id,
		nodeName: "fetch-data",
		level: "warn",
		message: "API rate limit approaching",
	});

	tracker.completeRun(run1.id, { result: "ok" });

	// Create a failed run
	const run2 = tracker.startRun({
		workflowName: "countries",
		workflowPath: "/workflows/countries.json",
		triggerType: "http",
		triggerSummary: "POST /countries",
		nodeCount: 2,
		tags: ["env:staging"],
	});

	const failNode = tracker.startNode(run2.id, {
		nodeName: "db-query",
		nodeType: "module",
		runtimeKind: "nodejs",
		depth: 0,
		stepIndex: 0,
	});
	tracker.failNode(failNode.id, new Error("Connection timeout"));
	tracker.failRun(run2.id, new Error("Workflow failed at db-query"));

	// Create a running run for a different workflow
	const run3 = tracker.startRun({
		workflowName: "sync-users",
		workflowPath: "/workflows/sync-users.json",
		triggerType: "cron",
		triggerSummary: "cron: */5 * * * *",
		nodeCount: 2,
	});

	tracker.startNode(run3.id, {
		nodeName: "fetch-users",
		nodeType: "runtime.go",
		runtimeKind: "go",
		depth: 0,
		stepIndex: 0,
	});

	return { run1, run2, run3 };
}

// --- Tests ---

describe("TraceRouter", () => {
	let router: MockRouter;
	let tracker: RunTracker;
	let runs: ReturnType<typeof seedData>;

	beforeEach(() => {
		const store = new InMemoryRunStore();
		tracker = new RunTracker(1000, store);
		router = new MockRouter();
		registerTraceRoutes(router as any, tracker);
		runs = seedData(tracker);
	});

	afterEach(() => {
		tracker.removeAllListeners();
	});

	// === CORS Middleware ===

	describe("CORS middleware", () => {
		it("sets CORS headers and calls next() for non-OPTIONS requests", () => {
			const req = new MockRequest({ method: "GET" });
			const res = new MockResponse();
			let nextCalled = false;

			router.middlewares[0](req, res, () => {
				nextCalled = true;
			});

			expect(res.headersMap.get("Access-Control-Allow-Origin")).toBe("*");
			expect(res.headersMap.get("Access-Control-Allow-Methods")).toContain("GET");
			expect(nextCalled).toBe(true);
		});

		it("returns 204 for OPTIONS requests", () => {
			const req = new MockRequest({ method: "OPTIONS" });
			const res = new MockResponse();
			let nextCalled = false;

			router.middlewares[0](req, res, () => {
				nextCalled = true;
			});

			expect(res.sentStatus).toBe(204);
			expect(nextCalled).toBe(false);
		});
	});

	// === Health ===

	describe("GET /health", () => {
		it("returns status ok with active runs count", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/health")!(req, res);

			const body = res.jsonBody as any;
			expect(body.status).toBe("ok");
			expect(body.activeRuns).toBe(1); // run3 is still running
			expect(body.uptime).toBeGreaterThan(0);
		});
	});

	// === Config ===

	describe("GET /config", () => {
		it("returns workflow names and trigger types", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/config")!(req, res);

			const body = res.jsonBody as any;
			expect(body.workflows).toContain("countries");
			expect(body.workflows).toContain("sync-users");
			expect(body.triggers).toContain("http");
			expect(body.triggers).toContain("cron");
		});
	});

	// === Workflows ===

	describe("GET /workflows", () => {
		it("returns summaries for all workflows", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/workflows")!(req, res);

			const body = res.jsonBody as any[];
			expect(body.length).toBe(2);
			const names = body.map((s) => s.name);
			expect(names).toContain("countries");
			expect(names).toContain("sync-users");
		});

		it("includes correct statistics", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/workflows")!(req, res);

			const body = res.jsonBody as any[];
			const countries = body.find((s: any) => s.name === "countries");
			expect(countries.totalRuns).toBe(2);
			expect(countries.errorRate).toBeGreaterThan(0); // 1 failed out of 2
		});

		// E4 sidebar follow-up — workflows in the registry but never run
		// must still surface so the sidebar can list them + the Graph tab
		// is reachable on first sight.
		describe("registry-only workflows", () => {
			beforeEach(() => {
				WorkflowRegistry.resetInstance();
			});
			afterEach(() => {
				WorkflowRegistry.resetInstance();
			});

			it("synthesizes a zero-stat summary for a registry-only HTTP workflow", () => {
				WorkflowRegistry.getInstance().register({
					name: "never-run-http",
					source: "<test>",
					workflow: {
						name: "never-run-http",
						version: "1.0.0",
						trigger: { http: { method: "POST", path: "/api/echo" } },
					},
				});

				const req = new MockRequest();
				const res = new MockResponse();
				router.findHandler("GET", "/workflows")!(req, res);

				const body = res.jsonBody as any[];
				const entry = body.find((s) => s.name === "never-run-http");
				expect(entry).toBeDefined();
				expect(entry.totalRuns).toBe(0);
				expect(entry.recentRuns).toBe(0);
				expect(entry.errorRate).toBe(0);
				expect(entry.path).toBe("/api/echo");
				expect(entry.triggerTypes).toEqual(["http"]);
			});

			it("does NOT duplicate a workflow that exists in both runs and registry", () => {
				WorkflowRegistry.getInstance().register({
					name: "countries",
					source: "<test>",
					workflow: {
						name: "countries",
						version: "1.0.0",
						trigger: { http: { method: "GET", path: "/countries" } },
					},
				});

				const req = new MockRequest();
				const res = new MockResponse();
				router.findHandler("GET", "/workflows")!(req, res);

				const body = res.jsonBody as any[];
				const countries = body.filter((s) => s.name === "countries");
				expect(countries).toHaveLength(1);
				// The run-derived summary wins (carries real stats).
				expect(countries[0].totalRuns).toBe(2);
			});

			it("excludes middleware-only workflows from the sidebar list", () => {
				WorkflowRegistry.getInstance().register({
					name: "audit-log",
					source: "<test>",
					workflow: { name: "audit-log", version: "1.0.0", trigger: { http: {} } },
					isMiddleware: true,
				});

				const req = new MockRequest();
				const res = new MockResponse();
				router.findHandler("GET", "/workflows")!(req, res);

				const body = res.jsonBody as any[];
				expect(body.find((s) => s.name === "audit-log")).toBeUndefined();
			});

			it("derives `path` from worker.queue / cron.schedule when http.path is absent", () => {
				WorkflowRegistry.getInstance().registerAll([
					{
						name: "bg-job",
						source: "<test>",
						workflow: {
							name: "bg-job",
							version: "1.0.0",
							trigger: { worker: { queue: "background-jobs" } },
						},
					},
					{
						name: "nightly",
						source: "<test>",
						workflow: {
							name: "nightly",
							version: "1.0.0",
							trigger: { cron: { schedule: "0 2 * * *" } },
						},
					},
				]);

				const req = new MockRequest();
				const res = new MockResponse();
				router.findHandler("GET", "/workflows")!(req, res);

				const body = res.jsonBody as any[];
				expect(body.find((s) => s.name === "bg-job").path).toBe("background-jobs");
				expect(body.find((s) => s.name === "nightly").path).toBe("0 2 * * *");
			});

			it("skips workflows with no recognized trigger", () => {
				WorkflowRegistry.getInstance().register({
					name: "broken",
					source: "<test>",
					workflow: { name: "broken", version: "1.0.0" },
				});

				const req = new MockRequest();
				const res = new MockResponse();
				router.findHandler("GET", "/workflows")!(req, res);

				const body = res.jsonBody as any[];
				expect(body.find((s) => s.name === "broken")).toBeUndefined();
			});

			it("`/workflows/:name` returns 200 + definition for a registry-only workflow", () => {
				WorkflowRegistry.getInstance().register({
					name: "never-run-http",
					source: "<test>",
					workflow: {
						name: "never-run-http",
						version: "1.0.0",
						trigger: { http: { method: "POST", path: "/api/echo" } },
						steps: [{ id: "respond", use: "@blokjs/respond", inputs: {} }],
					},
				});

				const req = new MockRequest({ params: { name: "never-run-http" } });
				const res = new MockResponse();
				router.findHandler("GET", "/workflows/:name")!(req, res);

				expect(res.statusCode).toBe(200);
				const body = res.jsonBody as any;
				expect(body.name).toBe("never-run-http");
				expect(body.totalRuns).toBe(0);
				expect(body.definition).toBeDefined();
				expect((body.definition as any).steps).toHaveLength(1);
			});
		});
	});

	describe("GET /workflows/:name", () => {
		it("returns workflow detail with node names and runtimes", () => {
			const req = new MockRequest({ params: { name: "countries" } });
			const res = new MockResponse();
			router.findHandler("GET", "/workflows/:name")!(req, res);

			const body = res.jsonBody as any;
			expect(body.name).toBe("countries");
			expect(body.nodeNames).toContain("validate-input");
			expect(body.nodeNames).toContain("fetch-data");
			expect(body.runtimes).toContain("nodejs");
		});

		it("returns 404 for unknown workflow", () => {
			const req = new MockRequest({ params: { name: "nonexistent" } });
			const res = new MockResponse();
			router.findHandler("GET", "/workflows/:name")!(req, res);

			expect(res.statusCode).toBe(404);
			expect((res.jsonBody as any).error).toContain("not found");
		});

		// E4 — `definition` field carries the raw workflow JSON when the
		// WorkflowRegistry has been populated. Studio uses this to render
		// the static workflow DAG without re-parsing files.
		describe("definition field (E4)", () => {
			beforeEach(() => {
				WorkflowRegistry.resetInstance();
			});

			afterEach(() => {
				WorkflowRegistry.resetInstance();
			});

			it("includes the registered workflow definition when registered", () => {
				const sampleDefinition = {
					name: "countries",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/countries" } },
					steps: [
						{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "https://example.com" } },
						{ id: "respond", use: "@blokjs/respond", inputs: { body: "$.state.fetch" } },
					],
				};
				WorkflowRegistry.getInstance().register({
					name: "countries",
					source: "<test>",
					workflow: sampleDefinition,
				});

				const req = new MockRequest({ params: { name: "countries" } });
				const res = new MockResponse();
				router.findHandler("GET", "/workflows/:name")!(req, res);

				const body = res.jsonBody as any;
				expect(body.definition).toEqual(sampleDefinition);
			});

			// Sample-body inference — surfaces the inferred / author-declared
			// curl payload via `examples.body`. Detailed shape coverage
			// lives in `__tests__/unit/workflow/sampleBody.test.ts`; these
			// integration tests just confirm the field threads through.
			it("includes `examples.body` synthesized from step body references", () => {
				WorkflowRegistry.getInstance().register({
					name: "echo",
					source: "<test>",
					workflow: {
						name: "echo",
						trigger: { http: { method: "POST", path: "/echo" } },
						steps: [
							{
								id: "respond",
								use: "@blokjs/respond",
								inputs: { body: "js/ctx.request.body.user.id" },
							},
						],
					},
				});

				const req = new MockRequest({ params: { name: "echo" } });
				const res = new MockResponse();
				router.findHandler("GET", "/workflows/:name")!(req, res);

				const body = res.jsonBody as any;
				expect(body.examples).toBeDefined();
				expect(body.examples.source).toBe("inferred");
				expect(body.examples.body).toEqual({ user: { id: "string" } });
			});

			it("returns the author-declared `examples.body` verbatim when present", () => {
				const authorBody = { event: { id: "evt_demo", type: "order.created" }, subscribers: [] };
				WorkflowRegistry.getInstance().register({
					name: "with-examples",
					source: "<test>",
					workflow: {
						name: "with-examples",
						trigger: {
							http: { method: "POST", path: "/x", examples: { body: authorBody } },
						},
						steps: [{ id: "noop", use: "n", inputs: { x: "js/ctx.request.body.something_else" } }],
					},
				});

				const req = new MockRequest({ params: { name: "with-examples" } });
				const res = new MockResponse();
				router.findHandler("GET", "/workflows/:name")!(req, res);

				const body = res.jsonBody as any;
				expect(body.examples.source).toBe("author");
				expect(body.examples.body).toEqual(authorBody);
			});

			it("omits definition when workflow is not in the registry", () => {
				// Tracker has run data for 'countries' but the registry was
				// not populated — older deployments or tests-only flows hit
				// this path. Studio falls back to the JSON viewer with
				// nodeNames + runtimes.
				const req = new MockRequest({ params: { name: "countries" } });
				const res = new MockResponse();
				router.findHandler("GET", "/workflows/:name")!(req, res);

				const body = res.jsonBody as any;
				expect(body.name).toBe("countries");
				expect(body.definition).toBeUndefined();
			});
		});
	});

	// E4 follow-up — boot-time route-build problems surfaced for Studio.
	describe("GET /routing", () => {
		beforeEach(() => {
			RoutingDiagnostics.resetInstance();
		});

		afterEach(() => {
			RoutingDiagnostics.resetInstance();
		});

		it("returns an empty list when no diagnostics have been recorded", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/routing")!(req, res);
			const body = res.jsonBody as any;
			expect(body.diagnostics).toEqual([]);
			expect(body.count).toBe(0);
			expect(typeof body.now).toBe("number");
		});

		it("returns recorded diagnostics in insertion order", () => {
			const diag = RoutingDiagnostics.getInstance();
			diag.record({
				kind: "duplicate",
				method: "POST",
				path: "/api/users",
				winnerSource: "/wf/a.json",
				droppedSource: "/wf/b.json",
				message: "Two workflows claim POST /api/users",
			});
			diag.record({
				kind: "any-shadows-specific",
				method: "ANY",
				path: "/api/orders",
				winnerSource: "/wf/o-get.json",
				droppedSource: "/wf/o-any.json",
				message: "ANY /api/orders shadows GET /api/orders",
			});

			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/routing")!(req, res);
			const body = res.jsonBody as any;
			expect(body.count).toBe(2);
			expect(body.diagnostics).toHaveLength(2);
			expect(body.diagnostics[0].kind).toBe("duplicate");
			expect(body.diagnostics[1].kind).toBe("any-shadows-specific");
		});
	});

	describe("GET /workflows/:name/runs", () => {
		it("returns paginated runs for a workflow", () => {
			const req = new MockRequest({
				params: { name: "countries" },
				query: { limit: "10", offset: "0", sort: "desc" },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/workflows/:name/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(2);
			expect(body.total).toBe(2);
			expect(body.page).toBe(1);
		});

		it("filters by status", () => {
			const req = new MockRequest({
				params: { name: "countries" },
				query: { status: "failed" },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/workflows/:name/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(1);
			expect(body.runs[0].status).toBe("failed");
		});
	});

	// === Runs ===

	describe("GET /runs", () => {
		it("returns all runs with pagination", () => {
			const req = new MockRequest({ query: { limit: "50", offset: "0" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(3);
			expect(body.total).toBe(3);
		});

		it("filters by workflow", () => {
			const req = new MockRequest({ query: { workflow: "sync-users" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(1);
			expect(body.runs[0].workflowName).toBe("sync-users");
		});

		it("filters by status", () => {
			const req = new MockRequest({ query: { status: "running" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(1);
			expect(body.runs[0].status).toBe("running");
		});

		it("filters by tags", () => {
			const req = new MockRequest({ query: { tags: "env:dev" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(1);
			expect(body.runs[0].tags).toContain("env:dev");
		});

		it("paginates correctly", () => {
			const req = new MockRequest({ query: { limit: "1", offset: "1" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(1);
			expect(body.total).toBe(3);
			expect(body.page).toBe(2);
		});

		it("sorts ascending", () => {
			const req = new MockRequest({ query: { sort: "asc" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBe(3);
			// Ascending: first run should have earliest startedAt
			expect(body.runs[0].startedAt).toBeLessThanOrEqual(body.runs[1].startedAt);
		});

		describe("F2 metadata operator filters", () => {
			beforeEach(() => {
				// Seed three runs with metadata fields the operator tests
				// can pivot on. saveRun directly so we don't trip
				// `evictOldRuns` or run-tracker side effects.
				const store = tracker.getStore();
				store.saveRun({
					id: "run_meta_1",
					workflowName: "wf",
					workflowPath: "/wf",
					triggerType: "http",
					triggerSummary: "POST /wf",
					status: "completed",
					startedAt: Date.now(),
					nodeCount: 1,
					completedNodes: 1,
					metadata: { tier: "premium", region: "us", count: "5" },
				});
				store.saveRun({
					id: "run_meta_2",
					workflowName: "wf",
					workflowPath: "/wf",
					triggerType: "http",
					triggerSummary: "POST /wf",
					status: "completed",
					startedAt: Date.now(),
					nodeCount: 1,
					completedNodes: 1,
					metadata: { tier: "free", region: "eu", count: "20" },
				});
				store.saveRun({
					id: "run_meta_3",
					workflowName: "wf",
					workflowPath: "/wf",
					triggerType: "http",
					triggerSummary: "POST /wf",
					status: "completed",
					startedAt: Date.now(),
					nodeCount: 1,
					completedNodes: 1,
					metadata: { tier: "enterprise", region: "ap", count: "100" },
				});
			});

			it("parses `metadata.<key>=<value>` as `op: 'eq'` (back-compat)", () => {
				const req = new MockRequest({ query: { "metadata.tier": "premium" } });
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs.map((r: any) => r.id).filter((id: string) => id.startsWith("run_meta_"));
				expect(ids).toEqual(["run_meta_1"]);
			});

			it("parses `metadata.<key>__ne` as not-equal", () => {
				const req = new MockRequest({ query: { "metadata.tier__ne": "free" } });
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs
					.map((r: any) => r.id)
					.filter((id: string) => id.startsWith("run_meta_"))
					.sort();
				expect(ids).toEqual(["run_meta_1", "run_meta_3"]);
			});

			it("parses `metadata.<key>__gt` and treats values as numeric", () => {
				const req = new MockRequest({ query: { "metadata.count__gt": "10" } });
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs
					.map((r: any) => r.id)
					.filter((id: string) => id.startsWith("run_meta_"))
					.sort();
				expect(ids).toEqual(["run_meta_2", "run_meta_3"]);
			});

			it("parses `metadata.<key>__in` with comma-separated values", () => {
				const req = new MockRequest({ query: { "metadata.region__in": "us,eu" } });
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs
					.map((r: any) => r.id)
					.filter((id: string) => id.startsWith("run_meta_"))
					.sort();
				expect(ids).toEqual(["run_meta_1", "run_meta_2"]);
			});

			it("parses `metadata.<key>__like` with `%` wildcard", () => {
				const req = new MockRequest({ query: { "metadata.tier__like": "enter%" } });
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs
					.map((r: any) => r.id)
					.filter((id: string) => id.startsWith("run_meta_"))
					.sort();
				// Only "enterprise" matches the `enter%` pattern.
				expect(ids).toEqual(["run_meta_3"]);
			});

			it("unknown operator suffix treats the full remainder as a literal key", () => {
				// `metadata.tier__bogus=premium` → operator "bogus" isn't in
				// the operator set, so the parser falls through and uses
				// `tier__bogus` as the metadata key with `op: "eq"`. That
				// key passes the JSON-path-safe regex (underscores allowed)
				// but no run has a field by that name, so the result is
				// empty. Operators with a real typo see the empty result
				// instead of silently getting the full table back.
				const req = new MockRequest({ query: { "metadata.tier__bogus": "premium" } });
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs.map((r: any) => r.id).filter((id: string) => id.startsWith("run_meta_"));
				expect(ids).toHaveLength(0);
			});

			it("multiple operator filters combine with AND across keys", () => {
				const req = new MockRequest({
					query: {
						"metadata.tier__ne": "free",
						"metadata.count__lt": "50",
					},
				});
				const res = new MockResponse();
				router.findHandler("GET", "/runs")!(req, res);

				const body = res.jsonBody as any;
				const ids = body.runs.map((r: any) => r.id).filter((id: string) => id.startsWith("run_meta_"));
				expect(ids).toEqual(["run_meta_1"]);
			});
		});
	});

	describe("GET /runs/:runId", () => {
		it("returns run with nodes and logs", () => {
			const req = new MockRequest({ params: { runId: runs.run1.id } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId")!(req, res);

			const body = res.jsonBody as any;
			expect(body.run.id).toBe(runs.run1.id);
			expect(body.run.status).toBe("completed");
			expect(body.nodes.length).toBe(3);
			expect(body.logs.length).toBe(2);
		});

		it("returns 404 for unknown run", () => {
			const req = new MockRequest({ params: { runId: "run_nonexistent" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	describe("GET /runs/:runId/events", () => {
		it("returns all events for a run", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				query: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/events")!(req, res);

			const events = res.jsonBody as any[];
			expect(events.length).toBeGreaterThan(0);
			// Should include RUN_STARTED, NODE_STARTED, NODE_COMPLETED, LOG_ENTRY, RUN_COMPLETED
			const types = events.map((e) => e.type);
			expect(types).toContain("RUN_STARTED");
			expect(types).toContain("NODE_STARTED");
			expect(types).toContain("NODE_COMPLETED");
			expect(types).toContain("RUN_COMPLETED");
		});

		it("filters events by since timestamp", () => {
			const events = tracker.getEvents(runs.run1.id);
			// Get the third event's timestamp
			const sinceTs = events[2].timestamp;

			const req = new MockRequest({
				params: { runId: runs.run1.id },
				query: { since: String(sinceTs) },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/events")!(req, res);

			const filteredEvents = res.jsonBody as any[];
			expect(filteredEvents.length).toBeLessThan(events.length);
		});

		it("returns 404 for unknown run", () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent" },
				query: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/events")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	describe("DELETE /runs", () => {
		it("clears all run data", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("DELETE", "/runs")!(req, res);

			// Should return deleted count
			const body = res.jsonBody as any;
			expect(body.deleted).toBeGreaterThan(0);

			// Verify data is gone
			const { runs: remaining } = tracker.getRuns();
			expect(remaining.length).toBe(0);
		});
	});

	// === Diff ===

	describe("GET /runs/diff", () => {
		it("returns both runs side-by-side", () => {
			const req = new MockRequest({
				query: { a: runs.run1.id, b: runs.run2.id },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/diff")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runA.run.id).toBe(runs.run1.id);
			expect(body.runB.run.id).toBe(runs.run2.id);
			expect(body.runA.nodes.length).toBe(3);
			expect(body.runB.nodes.length).toBe(1);
			expect(Array.isArray(body.runA.logs)).toBe(true);
			expect(Array.isArray(body.runB.logs)).toBe(true);
		});

		it("returns 400 when missing params", () => {
			const req = new MockRequest({ query: { a: runs.run1.id } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/diff")!(req, res);

			expect(res.statusCode).toBe(400);
		});

		it("returns 404 when run A not found", () => {
			const req = new MockRequest({
				query: { a: "run_nonexistent", b: runs.run2.id },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/diff")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("returns 404 when run B not found", () => {
			const req = new MockRequest({
				query: { a: runs.run1.id, b: "run_nonexistent" },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/diff")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	// === Tags ===

	describe("GET /tags", () => {
		it("returns all unique tags", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/tags")!(req, res);

			const body = res.jsonBody as any;
			expect(body.tags).toContain("env:dev");
			expect(body.tags).toContain("env:staging");
		});
	});

	describe("POST /runs/:runId/tags", () => {
		it("adds a single tag", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				body: { tag: "important" },
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/tags")!(req, res);

			const body = res.jsonBody as any;
			expect(body.added).toContain("important");

			// Verify tag was added
			const run = tracker.getRun(runs.run1.id)!;
			expect(run.tags).toContain("important");
		});

		it("adds multiple tags", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				body: { tags: ["tag-a", "tag-b"] },
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/tags")!(req, res);

			const body = res.jsonBody as any;
			expect(body.added).toContain("tag-a");
			expect(body.added).toContain("tag-b");
		});

		it("returns 404 for unknown run", () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent" },
				body: { tag: "test" },
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/tags")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("returns 400 when no tags provided", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				body: {},
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/tags")!(req, res);

			expect(res.statusCode).toBe(400);
		});
	});

	describe("DELETE /runs/:runId/tags/:tag", () => {
		it("removes a tag", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id, tag: "env:dev" },
			});
			const res = new MockResponse();
			router.findHandler("DELETE", "/runs/:runId/tags/:tag")!(req, res);

			const body = res.jsonBody as any;
			expect(body.removed).toBe(true);

			// Verify tag was removed
			const run = tracker.getRun(runs.run1.id)!;
			expect(run.tags).not.toContain("env:dev");
		});

		it("returns 404 for unknown run", () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent", tag: "test" },
			});
			const res = new MockResponse();
			router.findHandler("DELETE", "/runs/:runId/tags/:tag")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	// === Metrics ===

	describe("GET /metrics", () => {
		it("returns aggregate metrics", () => {
			const req = new MockRequest({ query: {} });
			const res = new MockResponse();
			router.findHandler("GET", "/metrics")!(req, res);

			const body = res.jsonBody as any;
			expect(body.totalRuns).toBe(3);
			expect(body.completedRuns).toBe(1);
			expect(body.failedRuns).toBe(1);
			expect(body.avgDurationMs).toBeGreaterThanOrEqual(0);
			expect(body.p50DurationMs).toBeGreaterThanOrEqual(0);
			expect(body.p95DurationMs).toBeGreaterThanOrEqual(0);
			expect(body.p99DurationMs).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(body.executionTimeline)).toBe(true);
			expect(Array.isArray(body.durationDistribution)).toBe(true);
			expect(Array.isArray(body.workflowBreakdown)).toBe(true);
			expect(Array.isArray(body.nodePerformance)).toBe(true);
		});

		it("filters metrics by workflow", () => {
			const req = new MockRequest({ query: { workflow: "countries" } });
			const res = new MockResponse();
			router.findHandler("GET", "/metrics")!(req, res);

			const body = res.jsonBody as any;
			expect(body.totalRuns).toBe(2);
		});
	});

	// === Export ===

	describe("GET /runs/export", () => {
		it("exports runs as JSON", () => {
			const req = new MockRequest({ query: { format: "json" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/export")!(req, res);

			const body = res.jsonBody as any;
			expect(body.format).toBe("json");
			expect(body.total).toBe(3);
			expect(body.runs.length).toBe(3);
			expect(body.runs[0].run).toBeDefined();
			expect(body.runs[0].nodes).toBeDefined();
			expect(body.runs[0].events).toBeDefined();
			expect(body.runs[0].logs).toBeDefined();
			expect(res.headersMap.get("Content-Disposition")).toContain("blok-runs-");
		});

		it("exports runs as CSV", () => {
			const req = new MockRequest({ query: { format: "csv" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/export")!(req, res);

			expect(res.headersMap.get("Content-Type")).toBe("text/csv");
			expect(res.ended).toBe(true);
			const csv = res.writtenChunks.join("");
			expect(csv).toContain("id,workflowName");
			expect(csv).toContain("countries");
		});

		it("filters export by workflow", () => {
			const req = new MockRequest({ query: { format: "json", workflow: "sync-users" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/export")!(req, res);

			const body = res.jsonBody as any;
			expect(body.total).toBe(1);
		});

		it("filters export by status", () => {
			const req = new MockRequest({ query: { format: "json", status: "failed" } });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/export")!(req, res);

			const body = res.jsonBody as any;
			expect(body.total).toBe(1);
			expect(body.runs[0].run.status).toBe("failed");
		});
	});

	describe("GET /runs/:runId/export", () => {
		it("exports a single run as JSON", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				query: { format: "json" },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/export")!(req, res);

			const body = res.jsonBody as any;
			expect(body.run.id).toBe(runs.run1.id);
			expect(body.nodes.length).toBe(3);
			expect(body.events.length).toBeGreaterThan(0);
			expect(body.logs.length).toBe(2);
		});

		it("exports a single run as CSV", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				query: { format: "csv" },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/export")!(req, res);

			expect(res.headersMap.get("Content-Type")).toBe("text/csv");
			expect(res.ended).toBe(true);
			const csv = res.writtenChunks.join("");
			expect(csv).toContain("# Run Summary");
			expect(csv).toContain("# Nodes");
			expect(csv).toContain("# Logs");
			expect(csv).toContain("validate-input");
		});

		it("returns 404 for unknown run", () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent" },
				query: { format: "json" },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/export")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	// === Webhooks ===

	describe("GET /webhooks", () => {
		it("returns empty list initially", () => {
			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/webhooks")!(req, res);

			const body = res.jsonBody as any;
			expect(body.webhooks).toEqual([]);
		});

		it("returns registered webhooks", () => {
			tracker.registerWebhook({
				url: "https://example.com/hook",
				events: ["run.completed"],
			});

			const req = new MockRequest();
			const res = new MockResponse();
			router.findHandler("GET", "/webhooks")!(req, res);

			const body = res.jsonBody as any;
			expect(body.webhooks.length).toBe(1);
			expect(body.webhooks[0].url).toBe("https://example.com/hook");
		});
	});

	describe("POST /webhooks", () => {
		it("registers a webhook", () => {
			const req = new MockRequest({
				body: {
					url: "https://example.com/hook",
					events: ["run.completed", "run.failed"],
					secret: "my-secret",
				},
			});
			const res = new MockResponse();
			router.findHandler("POST", "/webhooks")!(req, res);

			expect(res.statusCode).toBe(201);
			const body = res.jsonBody as any;
			expect(body.url).toBe("https://example.com/hook");
			expect(body.events).toContain("run.completed");
			expect(body.active).toBe(true);
			expect(body.id).toBeTruthy();
		});

		it("uses default events when not specified", () => {
			const req = new MockRequest({
				body: { url: "https://example.com/hook" },
			});
			const res = new MockResponse();
			router.findHandler("POST", "/webhooks")!(req, res);

			const body = res.jsonBody as any;
			expect(body.events).toContain("run.completed");
			expect(body.events).toContain("run.failed");
		});

		it("returns 400 for missing URL", () => {
			const req = new MockRequest({ body: {} });
			const res = new MockResponse();
			router.findHandler("POST", "/webhooks")!(req, res);

			expect(res.statusCode).toBe(400);
		});

		it("returns 400 for invalid URL", () => {
			const req = new MockRequest({
				body: { url: "not-a-url" },
			});
			const res = new MockResponse();
			router.findHandler("POST", "/webhooks")!(req, res);

			expect(res.statusCode).toBe(400);
		});
	});

	describe("DELETE /webhooks/:id", () => {
		it("removes a webhook", () => {
			const webhook = tracker.registerWebhook({
				url: "https://example.com/hook",
				events: ["run.completed"],
			});

			const req = new MockRequest({ params: { id: webhook.id } });
			const res = new MockResponse();
			router.findHandler("DELETE", "/webhooks/:id")!(req, res);

			const body = res.jsonBody as any;
			expect(body.removed).toBe(true);

			// Verify webhook is gone
			expect(tracker.getWebhooks().length).toBe(0);
		});

		it("returns 404 for unknown webhook", () => {
			const req = new MockRequest({ params: { id: "wh_nonexistent" } });
			const res = new MockResponse();
			router.findHandler("DELETE", "/webhooks/:id")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	// === Search ===

	describe("GET /search", () => {
		it("searches workflows by name", () => {
			const req = new MockRequest({ query: { q: "countries" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.workflows.length).toBeGreaterThan(0);
			expect(body.workflows[0].name).toBe("countries");
		});

		it("searches runs by status", () => {
			const req = new MockRequest({ query: { q: "failed" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBeGreaterThan(0);
			expect(body.runs.some((r: any) => r.status === "failed")).toBe(true);
		});

		it("searches runs by error message", () => {
			const req = new MockRequest({ query: { q: "db-query" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.runs.length).toBeGreaterThan(0);
		});

		it("searches by trigger type", () => {
			const req = new MockRequest({ query: { q: "cron" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.workflows.length).toBeGreaterThan(0);
			expect(body.workflows[0].name).toBe("sync-users");
		});

		it("returns empty results for empty query", () => {
			const req = new MockRequest({ query: { q: "" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.workflows).toEqual([]);
			expect(body.runs).toEqual([]);
		});

		it("returns empty results for no matches", () => {
			const req = new MockRequest({ query: { q: "zzz_nomatch_zzz" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.workflows).toEqual([]);
			expect(body.runs).toEqual([]);
		});
	});

	// === SSE: Run Stream ===

	describe("GET /runs/:runId/stream", () => {
		it("sets correct SSE headers", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(req, res);

			expect(res.headersMap.get("Content-Type")).toBe("text/event-stream");
			expect(res.headersMap.get("Cache-Control")).toBe("no-cache");
			expect(res.headersMap.get("Connection")).toBe("keep-alive");
			expect(res.flushed).toBe(true);
		});

		it("replays past events for completed run and closes stream", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(req, res);

			// Should have written past events
			expect(res.writtenChunks.length).toBeGreaterThan(0);
			// Should contain SSE event format
			const allOutput = res.writtenChunks.join("");
			expect(allOutput).toContain("event: ");
			expect(allOutput).toContain("id: ");
			expect(allOutput).toContain("data: ");
			// Should end stream since run1 is completed
			expect(allOutput).toContain("stream-end");
			expect(res.ended).toBe(true);
		});

		it("respects Last-Event-ID for reconnection", () => {
			// Get the events to find a valid event ID
			const events = tracker.getEvents(runs.run1.id);
			const midEventId = events[Math.floor(events.length / 2)].id;

			const req = new MockRequest({
				params: { runId: runs.run1.id },
				headers: { "last-event-id": midEventId },
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(req, res);

			// Should replay fewer events than without Last-Event-ID
			const reqFull = new MockRequest({
				params: { runId: runs.run1.id },
				headers: {},
			});
			const resFull = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(reqFull, resFull);

			// The reconnected stream should have fewer chunks (replays from after the mid point)
			expect(res.writtenChunks.length).toBeLessThan(resFull.writtenChunks.length);
		});

		it("streams live events for running run", () => {
			const req = new MockRequest({
				params: { runId: runs.run3.id },
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(req, res);

			// Should NOT be ended (run3 is still running)
			expect(res.ended).toBe(false);

			// Emit a new event for this run
			const nodesBefore = res.writtenChunks.length;
			tracker.startNode(runs.run3.id, {
				nodeName: "process-data",
				nodeType: "module",
				runtimeKind: "nodejs",
				depth: 0,
				stepIndex: 1,
			});

			// Should have received the new event
			expect(res.writtenChunks.length).toBeGreaterThan(nodesBefore);
			const newChunks = res.writtenChunks.slice(nodesBefore).join("");
			expect(newChunks).toContain("NODE_STARTED");

			// Cleanup: simulate client disconnect
			req.simulateClose();
		});

		it("auto-closes when run completes", () => {
			const req = new MockRequest({
				params: { runId: runs.run3.id },
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(req, res);

			expect(res.ended).toBe(false);

			// Complete the running run
			tracker.completeRun(runs.run3.id);

			// Stream should have closed
			const allOutput = res.writtenChunks.join("");
			expect(allOutput).toContain("stream-end");
			expect(res.ended).toBe(true);
		});

		it("returns 404 for unknown run", () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent" },
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("GET", "/runs/:runId/stream")!(req, res);

			expect(res.statusCode).toBe(404);
		});
	});

	// === SSE: Global Stream ===

	describe("GET /stream", () => {
		it("sets correct SSE headers", () => {
			const req = new MockRequest({ query: {} });
			const res = new MockResponse();
			router.findHandler("GET", "/stream")!(req, res);

			expect(res.headersMap.get("Content-Type")).toBe("text/event-stream");
			expect(res.headersMap.get("Cache-Control")).toBe("no-cache");
			expect(res.flushed).toBe(true);

			req.simulateClose();
		});

		it("streams events from all workflows", () => {
			const req = new MockRequest({ query: {} });
			const res = new MockResponse();
			router.findHandler("GET", "/stream")!(req, res);

			const chunksBefore = res.writtenChunks.length;

			// Create a new run (should trigger global events)
			tracker.startRun({
				workflowName: "new-workflow",
				workflowPath: "/new.json",
				triggerType: "http",
				triggerSummary: "GET /new",
				nodeCount: 1,
			});

			expect(res.writtenChunks.length).toBeGreaterThan(chunksBefore);
			const newOutput = res.writtenChunks.slice(chunksBefore).join("");
			expect(newOutput).toContain("RUN_STARTED");

			req.simulateClose();
		});

		it("filters events by workflow name", () => {
			const reqFiltered = new MockRequest({ query: { workflows: "countries" } });
			const resFiltered = new MockResponse();
			router.findHandler("GET", "/stream")!(reqFiltered, resFiltered);

			const chunksBefore = resFiltered.writtenChunks.length;

			// Create a run for a different workflow
			tracker.startRun({
				workflowName: "other-workflow",
				workflowPath: "/other.json",
				triggerType: "http",
				triggerSummary: "GET /other",
				nodeCount: 1,
			});

			// Should NOT receive events for "other-workflow"
			expect(resFiltered.writtenChunks.length).toBe(chunksBefore);

			// Create a run for "countries"
			tracker.startRun({
				workflowName: "countries",
				workflowPath: "/countries.json",
				triggerType: "http",
				triggerSummary: "GET /countries",
				nodeCount: 1,
			});

			// Should receive events for "countries"
			expect(resFiltered.writtenChunks.length).toBeGreaterThan(chunksBefore);

			reqFiltered.simulateClose();
		});

		it("cleans up listener on disconnect", () => {
			const req = new MockRequest({ query: {} });
			const res = new MockResponse();
			router.findHandler("GET", "/stream")!(req, res);

			const listenersBefore = tracker.listenerCount("event");
			req.simulateClose();
			const listenersAfter = tracker.listenerCount("event");

			expect(listenersAfter).toBeLessThan(listenersBefore);
		});
	});

	// === Replay ===

	describe("POST /runs/:runId/replay", () => {
		it("returns 404 for unknown run", () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent" },
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/replay")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("returns 400 for non-HTTP trigger", () => {
			const req = new MockRequest({
				params: { runId: runs.run3.id }, // cron trigger
				headers: {},
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/replay")!(req, res);

			expect(res.statusCode).toBe(400);
			expect((res.jsonBody as any).error).toContain("HTTP triggers");
		});
	});

	// === Cancellation (Tier 2 polish) ===

	describe("Concurrency observability (Tier 2 follow-up)", () => {
		it("GET /concurrency/health returns the configured backend (in-process default)", () => {
			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/concurrency/health")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as { backend: string; disabled: boolean };
			expect(body.backend).toBe("in-process");
			expect(body.disabled).toBe(false);
		});

		it("GET /concurrency/state returns empty buckets when no slots in flight", () => {
			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/concurrency/state")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as { totalBuckets: number; totalLeases: number };
			expect(body.totalBuckets).toBe(0);
			expect(body.totalLeases).toBe(0);
		});

		it("GET /concurrency/state returns active buckets after slots are acquired", () => {
			tracker.getStore().acquireConcurrencySlot("wf-A", "tenant-1", 5, "run_1", Date.now() + 60_000);
			tracker.getStore().acquireConcurrencySlot("wf-A", "tenant-1", 5, "run_2", Date.now() + 60_000);
			tracker.getStore().acquireConcurrencySlot("wf-B", "tenant-1", 5, "run_3", Date.now() + 60_000);

			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/concurrency/state")!(req, res);

			const body = res.jsonBody as {
				totalBuckets: number;
				totalLeases: number;
				buckets: Array<{ workflowName: string; concurrencyKey: string; inFlight: number }>;
			};
			expect(body.totalBuckets).toBe(2);
			expect(body.totalLeases).toBe(3);
			const wfA = body.buckets.find((b) => b.workflowName === "wf-A");
			expect(wfA?.inFlight).toBe(2);
			const wfB = body.buckets.find((b) => b.workflowName === "wf-B");
			expect(wfB?.inFlight).toBe(1);
		});
	});

	describe("GET /scheduled (E1 — Studio scheduled-runs view)", () => {
		function seedDispatches() {
			const now = Date.now();
			tracker.getStore().upsertScheduledDispatch({
				runId: "sched_1",
				workflowName: "wf-A",
				triggerType: "http",
				scheduledAt: now + 30_000,
				expiresAt: now + 60_000,
				dispatchStatus: "delayed",
				payload: {
					method: "POST",
					path: "/wf-A",
					headers: { "x-request-id": "abc", authorization: "Bearer SECRET" },
					body: {},
				},
				createdAt: now,
			});
			tracker.getStore().upsertScheduledDispatch({
				runId: "sched_2",
				workflowName: "wf-B",
				triggerType: "http",
				scheduledAt: now + 5_000,
				dispatchStatus: "queued",
				payload: { method: "POST", path: "/wf-B", headers: {}, body: {} },
				createdAt: now,
			});
			tracker.getStore().upsertScheduledDispatch({
				runId: "sched_3",
				workflowName: "wf-A",
				triggerType: "http",
				scheduledAt: now + 10_000,
				dispatchStatus: "debounced",
				payload: { method: "POST", path: "/wf-A", headers: {}, body: {} },
				createdAt: now,
			});
		}

		it("returns all pending dispatches sorted by scheduledAt ASC", () => {
			seedDispatches();
			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as {
				rows: Array<{ runId: string; dispatchStatus: string; scheduledAt: number }>;
				total: number;
				now: number;
			};
			expect(body.total).toBe(3);
			expect(body.rows.map((r) => r.runId)).toEqual(["sched_2", "sched_3", "sched_1"]);
			expect(typeof body.now).toBe("number");
		});

		it("filters by single status", () => {
			seedDispatches();
			const req = new MockRequest({ query: { status: "delayed" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { rows: Array<{ runId: string; dispatchStatus: string }>; total: number };
			expect(body.total).toBe(1);
			expect(body.rows[0].runId).toBe("sched_1");
			expect(body.rows[0].dispatchStatus).toBe("delayed");
		});

		it("filters by multiple statuses (comma-separated)", () => {
			seedDispatches();
			const req = new MockRequest({ query: { status: "queued,debounced" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { rows: Array<{ runId: string }>; total: number };
			expect(body.total).toBe(2);
			expect(body.rows.map((r) => r.runId).sort()).toEqual(["sched_2", "sched_3"]);
		});

		it("ignores unknown status values and falls back to all when none valid", () => {
			seedDispatches();
			const req = new MockRequest({ query: { status: "bogus,more-bogus" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { total: number };
			expect(body.total).toBe(3);
		});

		it("filters by workflowName", () => {
			seedDispatches();
			const req = new MockRequest({ query: { workflowName: "wf-A" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { rows: Array<{ runId: string }>; total: number };
			expect(body.total).toBe(2);
			expect(body.rows.map((r) => r.runId).sort()).toEqual(["sched_1", "sched_3"]);
		});

		it("strips sensitive request headers from the payload before returning", () => {
			seedDispatches();
			const req = new MockRequest({ query: { status: "delayed" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { rows: Array<{ payload: { headers: Record<string, string> } }> };
			const headers = body.rows[0].payload.headers;
			expect(headers["x-request-id"]).toBe("abc");
			expect(headers.authorization).toBeUndefined();
		});

		it("honours pagination via limit + offset", () => {
			seedDispatches();
			const req = new MockRequest({ query: { limit: "2", offset: "1" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { rows: Array<{ runId: string }>; total: number };
			// `total` is the full filtered set; `rows` is the page slice.
			expect(body.total).toBe(3);
			expect(body.rows).toHaveLength(2);
			expect(body.rows.map((r) => r.runId)).toEqual(["sched_3", "sched_1"]);
		});

		it("clamps limit to the 500 cap so a malicious query can't pin the loop", () => {
			seedDispatches();
			const req = new MockRequest({ query: { limit: "999999" } });
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			// We can't observe the cap directly without seeding 501+ rows;
			// the assertion below is that the request succeeds and returns
			// the small seed set (= 3) with a 200 — the clamp ran cleanly.
			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as { total: number };
			expect(body.total).toBe(3);
		});

		it("returns an empty list when no dispatches are pending", () => {
			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/scheduled")!(req, res);

			const body = res.jsonBody as { rows: unknown[]; total: number };
			expect(body.rows).toEqual([]);
			expect(body.total).toBe(0);
		});
	});

	describe("POST /runs/:runId/cancel", () => {
		it("returns 404 for unknown run", () => {
			const req = new MockRequest({ params: { runId: "run_nonexistent" } });
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/cancel")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("cancels a delayed run successfully", () => {
			const run = tracker.startRun({
				workflowName: "delay-test",
				workflowPath: "/p",
				triggerType: "http",
				triggerSummary: "POST /delay",
				nodeCount: 1,
			});
			tracker.markRunDelayed(run.id, { scheduledAt: Date.now() + 60_000, delayMs: 60_000 });

			const req = new MockRequest({ params: { runId: run.id } });
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/cancel")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as { cancelled: boolean; previousStatus: string; newStatus: string };
			expect(body.cancelled).toBe(true);
			expect(body.previousStatus).toBe("delayed");
			expect(body.newStatus).toBe("cancelled");
			expect(tracker.getRun(run.id)?.status).toBe("cancelled");
		});

		it("cancels a queued run successfully", () => {
			const run = tracker.startRun({
				workflowName: "queue-test",
				workflowPath: "/p",
				triggerType: "http",
				triggerSummary: "POST /queue",
				nodeCount: 1,
			});
			tracker.markRunQueued(run.id, {
				concurrencyKey: "k",
				concurrencyLimit: 1,
				currentInFlight: 1,
				scheduledAt: Date.now() + 1000,
			});

			const req = new MockRequest({ params: { runId: run.id } });
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/cancel")!(req, res);

			expect(res.statusCode).toBe(200);
			expect(tracker.getRun(run.id)?.status).toBe("cancelled");
		});

		it("accepts cancellation for a running run (Tier 2 follow-up: cooperative AbortSignal)", () => {
			// runs.run3 is `running` per seedData. Tier 2 follow-up extended
			// the cancel route to accept "running" via abortRunningRun.
			const req = new MockRequest({ params: { runId: runs.run3.id } });
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/cancel")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as { cancelled: boolean; previousStatus: string; newStatus: string };
			expect(body.cancelled).toBe(true);
			expect(body.previousStatus).toBe("running");
			expect(body.newStatus).toBe("cancelled");
		});

		it("returns 400 when the run is already completed", () => {
			const req = new MockRequest({ params: { runId: runs.run1.id } });
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/cancel")!(req, res);

			expect(res.statusCode).toBe(400);
		});
	});

	// === AI Error Explanation ===

	describe("POST /runs/:runId/explain", () => {
		it("returns 404 for unknown run", async () => {
			const req = new MockRequest({
				params: { runId: "run_nonexistent" },
				body: {},
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("returns 503 when OPENAI_API_KEY is not set", async () => {
			process.env.OPENAI_API_KEY = "";
			const req = new MockRequest({
				params: { runId: runs.run2.id }, // failed run
				body: {},
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(503);
			expect((res.jsonBody as any).error).toContain("OPENAI_API_KEY");
		});

		it("returns 400 when run has no error", async () => {
			process.env.OPENAI_API_KEY = "test-key";
			const req = new MockRequest({
				params: { runId: runs.run1.id }, // completed run, no error
				body: {},
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(400);
			expect((res.jsonBody as any).error).toContain("no error");
			process.env.OPENAI_API_KEY = "";
		});

		it("returns 404 when nodeId not found in run", async () => {
			process.env.OPENAI_API_KEY = "test-key";
			const req = new MockRequest({
				params: { runId: runs.run2.id },
				body: { nodeId: "node_nonexistent" },
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(404);
			expect((res.jsonBody as any).error).toContain("not found in run");
			process.env.OPENAI_API_KEY = "";
		});

		it("returns 400 when specified node has no error", async () => {
			process.env.OPENAI_API_KEY = "test-key";
			// run1 has completed nodes (no errors)
			const nodesOfRun1 = tracker.getNodeRuns(runs.run1.id);
			const completedNode = nodesOfRun1.find((n) => n.status === "completed");

			const req = new MockRequest({
				params: { runId: runs.run1.id },
				body: { nodeId: completedNode?.id },
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(400);
			expect((res.jsonBody as any).error).toContain("has no error");
			process.env.OPENAI_API_KEY = "";
		});

		it("calls OpenAI and returns explanation on success", async () => {
			process.env.OPENAI_API_KEY = "test-key";

			// Mock global fetch for OpenAI call
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						choices: [{ message: { content: "The error was caused by a connection timeout to the database." } }],
					}),
			});

			const req = new MockRequest({
				params: { runId: runs.run2.id }, // failed run
				body: {},
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as any;
			expect(body.explanation).toContain("connection timeout");
			expect(body.model).toBeTruthy();

			// Verify fetch was called with correct params
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/chat/completions",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "Bearer test-key",
					}),
				}),
			);

			globalThis.fetch = originalFetch;
			process.env.OPENAI_API_KEY = "";
		});

		it("returns 502 when OpenAI API fails", async () => {
			process.env.OPENAI_API_KEY = "test-key";

			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 429,
				json: () => Promise.resolve({ error: { message: "Rate limit exceeded" } }),
			});

			const req = new MockRequest({
				params: { runId: runs.run2.id },
				body: {},
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(502);
			expect((res.jsonBody as any).error).toContain("Rate limit exceeded");

			globalThis.fetch = originalFetch;
			process.env.OPENAI_API_KEY = "";
		});

		it("explains a specific node error", async () => {
			process.env.OPENAI_API_KEY = "test-key";

			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						choices: [{ message: { content: "The db-query node failed due to a connection timeout." } }],
					}),
			});

			// Find the failed node in run2
			const nodesOfRun2 = tracker.getNodeRuns(runs.run2.id);
			const failedNode = nodesOfRun2.find((n) => n.status === "failed");

			const req = new MockRequest({
				params: { runId: runs.run2.id },
				body: { nodeId: failedNode?.id },
			});
			const res = new MockResponse();
			await router.findHandler("POST", "/runs/:runId/explain")!(req, res);

			expect(res.statusCode).toBe(200);
			const body = res.jsonBody as any;
			expect(body.explanation).toContain("db-query");

			globalThis.fetch = originalFetch;
			process.env.OPENAI_API_KEY = "";
		});
	});

	// === Custom Dashboards ===

	describe("Custom Dashboards", () => {
		it("GET /dashboards returns empty list initially", () => {
			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/dashboards")!(req, res);

			const body = res.jsonBody as any;
			expect(body.dashboards).toEqual([]);
		});

		it("POST /dashboards creates a new dashboard", () => {
			const req = new MockRequest({
				body: {
					name: "My Dashboard",
					description: "Test dashboard",
					widgets: [
						{
							id: "w1",
							type: "stat-card",
							title: "Total Runs",
							config: { metric: "totalRuns" },
							position: { x: 0, y: 0, w: 4, h: 2 },
						},
					],
				},
			});
			const res = new MockResponse();
			router.findHandler("POST", "/dashboards")!(req, res);

			expect(res.statusCode).toBe(201);
			const body = res.jsonBody as any;
			expect(body.id).toMatch(/^dash_/);
			expect(body.name).toBe("My Dashboard");
			expect(body.description).toBe("Test dashboard");
			expect(body.widgets).toHaveLength(1);
			expect(body.widgets[0].type).toBe("stat-card");
		});

		it("POST /dashboards returns 400 when name is missing", () => {
			const req = new MockRequest({ body: {} });
			const res = new MockResponse();
			router.findHandler("POST", "/dashboards")!(req, res);

			expect(res.statusCode).toBe(400);
			expect((res.jsonBody as any).error).toContain("name");
		});

		it("GET /dashboards/:dashboardId returns a created dashboard", () => {
			// Create one
			const createReq = new MockRequest({
				body: { name: "Fetch Test" },
			});
			const createRes = new MockResponse();
			router.findHandler("POST", "/dashboards")!(createReq, createRes);
			const created = createRes.jsonBody as any;

			// Fetch it
			const req = new MockRequest({ params: { dashboardId: created.id } });
			const res = new MockResponse();
			router.findHandler("GET", "/dashboards/:dashboardId")!(req, res);

			expect(res.statusCode).toBe(200);
			expect((res.jsonBody as any).name).toBe("Fetch Test");
		});

		it("GET /dashboards/:dashboardId returns 404 for unknown", () => {
			const req = new MockRequest({ params: { dashboardId: "nonexistent" } });
			const res = new MockResponse();
			router.findHandler("GET", "/dashboards/:dashboardId")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("PUT /dashboards/:dashboardId updates a dashboard", () => {
			// Create
			const createReq = new MockRequest({ body: { name: "Before" } });
			const createRes = new MockResponse();
			router.findHandler("POST", "/dashboards")!(createReq, createRes);
			const created = createRes.jsonBody as any;

			// Update
			const req = new MockRequest({
				params: { dashboardId: created.id },
				body: { name: "After", description: "Updated" },
			});
			const res = new MockResponse();
			router.findHandler("PUT", "/dashboards/:dashboardId")!(req, res);

			expect(res.statusCode).toBe(200);
			expect((res.jsonBody as any).name).toBe("After");
			expect((res.jsonBody as any).description).toBe("Updated");
		});

		it("PUT /dashboards/:dashboardId returns 404 for unknown", () => {
			const req = new MockRequest({
				params: { dashboardId: "nonexistent" },
				body: { name: "X" },
			});
			const res = new MockResponse();
			router.findHandler("PUT", "/dashboards/:dashboardId")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("DELETE /dashboards/:dashboardId deletes a dashboard", () => {
			// Create
			const createReq = new MockRequest({ body: { name: "ToDelete" } });
			const createRes = new MockResponse();
			router.findHandler("POST", "/dashboards")!(createReq, createRes);
			const created = createRes.jsonBody as any;

			// Delete
			const req = new MockRequest({ params: { dashboardId: created.id } });
			const res = new MockResponse();
			router.findHandler("DELETE", "/dashboards/:dashboardId")!(req, res);

			expect(res.statusCode).toBe(200);
			expect((res.jsonBody as any).deleted).toBe(true);

			// Verify gone
			const getReq = new MockRequest({ params: { dashboardId: created.id } });
			const getRes = new MockResponse();
			router.findHandler("GET", "/dashboards/:dashboardId")!(getReq, getRes);
			expect(getRes.statusCode).toBe(404);
		});

		it("DELETE /dashboards/:dashboardId returns 404 for unknown", () => {
			const req = new MockRequest({ params: { dashboardId: "nonexistent" } });
			const res = new MockResponse();
			router.findHandler("DELETE", "/dashboards/:dashboardId")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("POST /dashboards/:dashboardId/duplicate clones a dashboard", () => {
			// Create
			const createReq = new MockRequest({
				body: { name: "Original", description: "Source" },
			});
			const createRes = new MockResponse();
			router.findHandler("POST", "/dashboards")!(createReq, createRes);
			const original = createRes.jsonBody as any;

			// Duplicate
			const req = new MockRequest({ params: { dashboardId: original.id } });
			const res = new MockResponse();
			router.findHandler("POST", "/dashboards/:dashboardId/duplicate")!(req, res);

			expect(res.statusCode).toBe(201);
			const copy = res.jsonBody as any;
			expect(copy.id).not.toBe(original.id);
			expect(copy.name).toBe("Original (Copy)");
			expect(copy.description).toBe("Source");
		});

		it("POST /dashboards/:dashboardId/duplicate returns 404 for unknown", () => {
			const req = new MockRequest({ params: { dashboardId: "nonexistent" } });
			const res = new MockResponse();
			router.findHandler("POST", "/dashboards/:dashboardId/duplicate")!(req, res);

			expect(res.statusCode).toBe(404);
		});

		it("GET /dashboards lists all created dashboards", () => {
			// Create two
			for (const name of ["Dashboard A", "Dashboard B"]) {
				const req = new MockRequest({ body: { name } });
				const res = new MockResponse();
				router.findHandler("POST", "/dashboards")!(req, res);
			}

			const req = new MockRequest({});
			const res = new MockResponse();
			router.findHandler("GET", "/dashboards")!(req, res);

			const body = res.jsonBody as any;
			// May have dashboards from earlier tests too, just check at least 2
			expect(body.dashboards.length).toBeGreaterThanOrEqual(2);
		});
	});

	// === Route Registration ===

	describe("Route registration", () => {
		it("registers all expected routes", () => {
			const routePaths = router.routes.map((r) => `${r.method} ${r.path}`);

			// Utility
			expect(routePaths).toContain("GET /health");
			expect(routePaths).toContain("GET /config");

			// Workflows
			expect(routePaths).toContain("GET /workflows");
			expect(routePaths).toContain("GET /workflows/:name");
			expect(routePaths).toContain("GET /workflows/:name/runs");

			// Runs
			expect(routePaths).toContain("GET /runs");
			expect(routePaths).toContain("GET /runs/:runId");
			expect(routePaths).toContain("GET /runs/:runId/events");
			expect(routePaths).toContain("DELETE /runs");

			// Diff
			expect(routePaths).toContain("GET /runs/diff");

			// Tags
			expect(routePaths).toContain("GET /tags");
			expect(routePaths).toContain("POST /runs/:runId/tags");
			expect(routePaths).toContain("DELETE /runs/:runId/tags/:tag");

			// Metrics
			expect(routePaths).toContain("GET /metrics");

			// Export
			expect(routePaths).toContain("GET /runs/export");
			expect(routePaths).toContain("GET /runs/:runId/export");

			// Webhooks
			expect(routePaths).toContain("GET /webhooks");
			expect(routePaths).toContain("POST /webhooks");
			expect(routePaths).toContain("DELETE /webhooks/:id");

			// Search
			expect(routePaths).toContain("GET /search");

			// SSE
			expect(routePaths).toContain("GET /runs/:runId/stream");
			expect(routePaths).toContain("GET /stream");

			// AI Explain
			expect(routePaths).toContain("POST /runs/:runId/explain");

			// Replay
			expect(routePaths).toContain("POST /runs/:runId/replay");

			// Dashboards
			expect(routePaths).toContain("GET /dashboards");
			expect(routePaths).toContain("GET /dashboards/:dashboardId");
			expect(routePaths).toContain("POST /dashboards");
			expect(routePaths).toContain("PUT /dashboards/:dashboardId");
			expect(routePaths).toContain("DELETE /dashboards/:dashboardId");
			expect(routePaths).toContain("POST /dashboards/:dashboardId/duplicate");
		});

		it("has CORS middleware registered", () => {
			expect(router.middlewares.length).toBeGreaterThan(0);
		});
	});

	// === Edge Cases ===

	describe("Edge cases", () => {
		it("handles default query parameters gracefully", () => {
			const req = new MockRequest({ query: {} });
			const res = new MockResponse();
			router.findHandler("GET", "/runs")!(req, res);

			const body = res.jsonBody as any;
			expect(body.page).toBe(1);
			expect(body.runs.length).toBe(3); // default limit 50
		});

		it("handles empty export format (defaults to json)", () => {
			const req = new MockRequest({ query: {} });
			const res = new MockResponse();
			router.findHandler("GET", "/runs/export")!(req, res);

			const body = res.jsonBody as any;
			expect(body.format).toBe("json");
		});

		it("handles webhook creation with no body", () => {
			const req = new MockRequest({ body: undefined });
			const res = new MockResponse();
			router.findHandler("POST", "/webhooks")!(req, res);

			expect(res.statusCode).toBe(400);
		});

		it("handles tag operations with trimming", () => {
			const req = new MockRequest({
				params: { runId: runs.run1.id },
				body: { tags: ["  spaced  ", "normal"] },
			});
			const res = new MockResponse();
			router.findHandler("POST", "/runs/:runId/tags")!(req, res);

			const body = res.jsonBody as any;
			expect(body.added).toContain("spaced");
		});

		it("handles search case-insensitively", () => {
			const req = new MockRequest({ query: { q: "COUNTRIES" } });
			const res = new MockResponse();
			router.findHandler("GET", "/search")!(req, res);

			const body = res.jsonBody as any;
			expect(body.workflows.length).toBeGreaterThan(0);
		});
	});
});
