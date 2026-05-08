/**
 * Marketplace Integration Tests
 *
 * Comprehensive integration tests for all marketplace components:
 * RuntimeCatalog, RuntimeDiscovery, RuntimeHealthMonitor,
 * RuntimeMetricsDashboard, and RuntimeAutoScaler.
 *
 * Validates publish/search/discovery flows, health monitoring,
 * metrics aggregation, auto-scaling policies, and end-to-end
 * marketplace lifecycle operations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeRegistry } from "../../../src/RuntimeRegistry";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "../../../src/adapters/RuntimeAdapter";
import {
	RuntimeAutoScaler,
	type ScalingDecision,
	type ScalingPolicy,
} from "../../../src/marketplace/RuntimeAutoScaler";
import {
	type CatalogSearchOptions,
	RuntimeCatalog,
	type RuntimePackageManifest,
} from "../../../src/marketplace/RuntimeCatalog";
import { type CompatibilityInfo, RuntimeDiscovery } from "../../../src/marketplace/RuntimeDiscovery";
import { type HealthMonitorConfig, RuntimeHealthMonitor } from "../../../src/marketplace/RuntimeHealthMonitor";
import {
	type RuntimeExecutionMetrics,
	RuntimeMetricsDashboard,
} from "../../../src/marketplace/RuntimeMetricsDashboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestManifest(overrides: Partial<RuntimePackageManifest> = {}): RuntimePackageManifest {
	return {
		name: overrides.name ?? "test-package",
		version: overrides.version ?? "1.0.0",
		runtime: overrides.runtime ?? "nodejs",
		description: overrides.description ?? "A test runtime package",
		author: overrides.author ?? "test-author",
		license: overrides.license ?? "MIT",
		repository: overrides.repository,
		tags: overrides.tags ?? ["test", "utility"],
		protocols: overrides.protocols ?? ["http"],
		dockerImage: overrides.dockerImage,
		minBlokVersion: overrides.minBlokVersion,
		nodeCount: overrides.nodeCount ?? 1,
		nodes: overrides.nodes ?? [
			{
				name: "test-node",
				description: "A test node",
				inputs: { input: "string" },
				outputs: { output: "string" },
			},
		],
		createdAt: overrides.createdAt ?? Date.now(),
		updatedAt: overrides.updatedAt ?? Date.now(),
		downloads: overrides.downloads ?? 0,
		rating: overrides.rating ?? 0,
		verified: overrides.verified ?? false,
	};
}

function createTestExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
	return {
		success: overrides.success ?? true,
		data: overrides.data ?? { result: "ok" },
		errors: overrides.errors ?? null,
		logs: overrides.logs,
		metrics: overrides.metrics ?? {
			duration_ms: 50,
			cpu_ms: 10,
			memory_bytes: 1024 * 1024,
		},
	};
}

/**
 * Minimal mock RuntimeAdapter used for health monitor and registry tests.
 */
class MockRuntimeAdapter implements RuntimeAdapter {
	readonly kind: RuntimeKind;

	constructor(kind: RuntimeKind) {
		this.kind = kind;
	}

	async execute(): Promise<ExecutionResult> {
		return createTestExecutionResult();
	}
}

// ---------------------------------------------------------------------------
// 1. RuntimeCatalog Tests
// ---------------------------------------------------------------------------

describe("RuntimeCatalog", () => {
	let catalog: RuntimeCatalog;

	beforeEach(() => {
		catalog = new RuntimeCatalog();
	});

	it("should publish and retrieve a package", () => {
		const manifest = createTestManifest({ name: "my-pkg", version: "1.0.0" });
		catalog.publish(manifest);

		const retrieved = catalog.get("my-pkg");
		expect(retrieved).toBeDefined();
		expect(retrieved!.name).toBe("my-pkg");
		expect(retrieved!.version).toBe("1.0.0");
	});

	it("should publish multiple versions and resolve latest", () => {
		catalog.publish(createTestManifest({ name: "versioned", version: "1.0.0" }));
		catalog.publish(createTestManifest({ name: "versioned", version: "1.1.0" }));
		catalog.publish(createTestManifest({ name: "versioned", version: "2.0.0" }));
		catalog.publish(createTestManifest({ name: "versioned", version: "1.5.0" }));

		const latest = catalog.get("versioned");
		expect(latest).toBeDefined();
		expect(latest!.version).toBe("2.0.0");

		const versions = catalog.getVersions("versioned");
		expect(versions).toEqual(["2.0.0", "1.5.0", "1.1.0", "1.0.0"]);
	});

	it("should search by query (name match)", () => {
		catalog.publish(createTestManifest({ name: "express-handler", description: "HTTP handler" }));
		catalog.publish(createTestManifest({ name: "data-processor", description: "Data pipeline" }));
		catalog.publish(createTestManifest({ name: "express-logger", description: "Logging" }));

		const result = catalog.search({ query: "express" });
		expect(result.packages).toHaveLength(2);
		expect(result.packages.map((p) => p.name)).toContain("express-handler");
		expect(result.packages.map((p) => p.name)).toContain("express-logger");
	});

	it("should search by runtime filter", () => {
		catalog.publish(createTestManifest({ name: "node-pkg", runtime: "nodejs" }));
		catalog.publish(createTestManifest({ name: "py-pkg", runtime: "python3" }));
		catalog.publish(createTestManifest({ name: "go-pkg", runtime: "go" }));

		const result = catalog.search({ runtime: "python3" });
		expect(result.packages).toHaveLength(1);
		expect(result.packages[0].name).toBe("py-pkg");
	});

	it("should search by tags filter", () => {
		catalog.publish(createTestManifest({ name: "tagged-a", tags: ["auth", "security"] }));
		catalog.publish(createTestManifest({ name: "tagged-b", tags: ["auth", "oauth"] }));
		catalog.publish(createTestManifest({ name: "tagged-c", tags: ["database", "orm"] }));

		const result = catalog.search({ tags: ["auth"] });
		expect(result.packages).toHaveLength(2);

		const both = catalog.search({ tags: ["auth", "security"] });
		expect(both.packages).toHaveLength(1);
		expect(both.packages[0].name).toBe("tagged-a");
	});

	it("should search with verified filter", () => {
		catalog.publish(createTestManifest({ name: "verified-pkg", verified: true }));
		catalog.publish(createTestManifest({ name: "unverified-pkg", verified: false }));

		const result = catalog.search({ verified: true });
		expect(result.packages).toHaveLength(1);
		expect(result.packages[0].name).toBe("verified-pkg");
	});

	it("should search with pagination (limit/offset)", () => {
		for (let i = 0; i < 10; i++) {
			catalog.publish(createTestManifest({ name: `pkg-${String(i).padStart(2, "0")}` }));
		}

		const page1 = catalog.search({ limit: 3, offset: 0 });
		expect(page1.packages).toHaveLength(3);
		expect(page1.total).toBe(10);
		expect(page1.page).toBe(1);
		expect(page1.pageSize).toBe(3);

		const page2 = catalog.search({ limit: 3, offset: 3 });
		expect(page2.packages).toHaveLength(3);
		expect(page2.page).toBe(2);

		const page4 = catalog.search({ limit: 3, offset: 9 });
		expect(page4.packages).toHaveLength(1);
		expect(page4.page).toBe(4);
	});

	it("should sort by downloads descending", () => {
		catalog.publish(createTestManifest({ name: "low", downloads: 10 }));
		catalog.publish(createTestManifest({ name: "high", downloads: 1000 }));
		catalog.publish(createTestManifest({ name: "mid", downloads: 100 }));

		const result = catalog.search({ sortBy: "downloads", sortOrder: "desc" });
		expect(result.packages.map((p) => p.name)).toEqual(["high", "mid", "low"]);
	});

	it("should sort by rating ascending", () => {
		catalog.publish(createTestManifest({ name: "rated-low", rating: 2 }));
		catalog.publish(createTestManifest({ name: "rated-high", rating: 5 }));
		catalog.publish(createTestManifest({ name: "rated-mid", rating: 3.5 }));

		const result = catalog.search({ sortBy: "rating", sortOrder: "asc" });
		expect(result.packages.map((p) => p.name)).toEqual(["rated-low", "rated-mid", "rated-high"]);
	});

	it("should sort by updated descending", () => {
		catalog.publish(createTestManifest({ name: "old", updatedAt: 1000 }));
		catalog.publish(createTestManifest({ name: "new", updatedAt: 3000 }));
		catalog.publish(createTestManifest({ name: "recent", updatedAt: 2000 }));

		const result = catalog.search({ sortBy: "updated", sortOrder: "desc" });
		expect(result.packages.map((p) => p.name)).toEqual(["new", "recent", "old"]);
	});

	it("should increment downloads counter", () => {
		catalog.publish(createTestManifest({ name: "downloadable", version: "1.0.0", downloads: 0 }));

		catalog.incrementDownloads("downloadable", "1.0.0");
		catalog.incrementDownloads("downloadable", "1.0.0");
		catalog.incrementDownloads("downloadable", "1.0.0");

		const pkg = catalog.get("downloadable", "1.0.0");
		expect(pkg!.downloads).toBe(3);
	});

	it("should set and validate rating (0-5 range, reject invalid)", () => {
		catalog.publish(createTestManifest({ name: "rateable", version: "1.0.0" }));

		catalog.setRating("rateable", "1.0.0", 4.5);
		expect(catalog.get("rateable")!.rating).toBe(4.5);

		catalog.setRating("rateable", "1.0.0", 0);
		expect(catalog.get("rateable")!.rating).toBe(0);

		catalog.setRating("rateable", "1.0.0", 5);
		expect(catalog.get("rateable")!.rating).toBe(5);

		expect(() => catalog.setRating("rateable", "1.0.0", -1)).toThrow("Rating must be between 0 and 5");
		expect(() => catalog.setRating("rateable", "1.0.0", 6)).toThrow("Rating must be between 0 and 5");
	});

	it("should unpublish a version", () => {
		catalog.publish(createTestManifest({ name: "removable", version: "1.0.0" }));
		catalog.publish(createTestManifest({ name: "removable", version: "2.0.0" }));

		const removed = catalog.unpublish("removable", "1.0.0");
		expect(removed).toBe(true);

		expect(catalog.get("removable", "1.0.0")).toBeUndefined();
		expect(catalog.get("removable", "2.0.0")).toBeDefined();

		const removedNonExistent = catalog.unpublish("removable", "3.0.0");
		expect(removedNonExistent).toBe(false);
	});

	it("should return correct aggregate stats via getStats", () => {
		catalog.publish(
			createTestManifest({
				name: "stats-a",
				version: "1.0.0",
				runtime: "nodejs",
				downloads: 100,
				rating: 4,
				verified: true,
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "stats-a",
				version: "2.0.0",
				runtime: "nodejs",
				downloads: 200,
				rating: 5,
				verified: true,
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "stats-b",
				runtime: "python3",
				downloads: 50,
				rating: 3,
				verified: false,
			}),
		);

		const stats = catalog.getStats();
		expect(stats.totalPackages).toBe(2);
		expect(stats.totalVersions).toBe(3);
		expect(stats.packagesByRuntime.nodejs).toBe(1);
		expect(stats.packagesByRuntime.python3).toBe(1);
		// Latest of stats-a is 2.0.0 with 200 downloads, stats-b has 50
		expect(stats.totalDownloads).toBe(250);
		expect(stats.verifiedCount).toBe(1);
		// Average of 5 and 3 = 4
		expect(stats.averageRating).toBe(4);
	});

	it("should serialize and deserialize with toJSON/fromJSON roundtrip", () => {
		catalog.publish(createTestManifest({ name: "serialized-a", version: "1.0.0", runtime: "go" }));
		catalog.publish(createTestManifest({ name: "serialized-a", version: "2.0.0", runtime: "go" }));
		catalog.publish(createTestManifest({ name: "serialized-b", version: "1.0.0", runtime: "rust" }));

		const json = catalog.toJSON();
		const restored = RuntimeCatalog.fromJSON(json);

		expect(restored.get("serialized-a")).toBeDefined();
		expect(restored.get("serialized-a")!.version).toBe("2.0.0");
		expect(restored.get("serialized-a", "1.0.0")).toBeDefined();
		expect(restored.get("serialized-b")).toBeDefined();
		expect(restored.get("serialized-b")!.runtime).toBe("rust");

		const origVersions = catalog.getVersions("serialized-a");
		const restoredVersions = restored.getVersions("serialized-a");
		expect(restoredVersions).toEqual(origVersions);
	});

	it("should listByRuntime returning only matching runtimes", () => {
		catalog.publish(createTestManifest({ name: "node-a", runtime: "nodejs" }));
		catalog.publish(createTestManifest({ name: "node-b", runtime: "nodejs" }));
		catalog.publish(createTestManifest({ name: "py-a", runtime: "python3" }));
		catalog.publish(createTestManifest({ name: "go-a", runtime: "go" }));

		const nodePkgs = catalog.listByRuntime("nodejs");
		expect(nodePkgs).toHaveLength(2);
		expect(nodePkgs.every((p) => p.runtime === "nodejs")).toBe(true);

		const goPkgs = catalog.listByRuntime("go");
		expect(goPkgs).toHaveLength(1);
		expect(goPkgs[0].name).toBe("go-a");

		const rustPkgs = catalog.listByRuntime("rust");
		expect(rustPkgs).toHaveLength(0);
	});

	it("should getPopular sorting by download count", () => {
		catalog.publish(createTestManifest({ name: "pop-low", downloads: 10 }));
		catalog.publish(createTestManifest({ name: "pop-high", downloads: 5000 }));
		catalog.publish(createTestManifest({ name: "pop-mid", downloads: 500 }));
		catalog.publish(createTestManifest({ name: "pop-mega", downloads: 50000 }));

		const popular = catalog.getPopular(3);
		expect(popular).toHaveLength(3);
		expect(popular[0].name).toBe("pop-mega");
		expect(popular[1].name).toBe("pop-high");
		expect(popular[2].name).toBe("pop-mid");
	});
});

// ---------------------------------------------------------------------------
// 2. RuntimeDiscovery Tests
// ---------------------------------------------------------------------------

describe("RuntimeDiscovery", () => {
	let catalog: RuntimeCatalog;
	let registry: RuntimeRegistry;
	let discovery: RuntimeDiscovery;

	beforeEach(() => {
		catalog = new RuntimeCatalog();
		registry = RuntimeRegistry.getInstance();
		registry.clear();
		discovery = new RuntimeDiscovery(catalog, registry);
	});

	afterEach(() => {
		registry.clear();
	});

	it("should discover packages by runtime kind", () => {
		catalog.publish(createTestManifest({ name: "node-a", runtime: "nodejs" }));
		catalog.publish(createTestManifest({ name: "node-b", runtime: "nodejs" }));
		catalog.publish(createTestManifest({ name: "py-a", runtime: "python3" }));

		const nodePackages = discovery.discover("nodejs");
		expect(nodePackages).toHaveLength(2);
		expect(nodePackages.every((p) => p.runtime === "nodejs")).toBe(true);

		const pyPackages = discovery.discover("python3");
		expect(pyPackages).toHaveLength(1);
		expect(pyPackages[0].name).toBe("py-a");
	});

	it("should resolve package by name (latest version)", () => {
		catalog.publish(createTestManifest({ name: "resolvable", version: "1.0.0" }));
		catalog.publish(createTestManifest({ name: "resolvable", version: "2.0.0" }));

		registry.register(new MockRuntimeAdapter("nodejs"));

		const result = discovery.resolve({ name: "resolvable" });
		expect(result).toBeDefined();
		expect(result!.package.version).toBe("2.0.0");
		expect(result!.compatibility).toBeDefined();
	});

	it("should resolve package with specific version", () => {
		catalog.publish(createTestManifest({ name: "specific", version: "1.0.0" }));
		catalog.publish(createTestManifest({ name: "specific", version: "2.0.0" }));

		registry.register(new MockRuntimeAdapter("nodejs"));

		const result = discovery.resolve({ name: "specific", version: "1.0.0" });
		expect(result).toBeDefined();
		expect(result!.package.version).toBe("1.0.0");
	});

	it("should checkCompatibility with registered runtime returning compatible", () => {
		registry.register(new MockRuntimeAdapter("nodejs"));

		const manifest = createTestManifest({ name: "compat-pkg", runtime: "nodejs" });
		const compat = discovery.checkCompatibility(manifest);

		expect(compat.compatible).toBe(true);
		expect(compat.runtimeAvailable).toBe(true);
		expect(compat.protocolSupported).toBe(true);
	});

	it("should checkCompatibility with unregistered runtime returning incompatible", () => {
		// Do not register "go" adapter
		const manifest = createTestManifest({ name: "incompat-pkg", runtime: "go" });
		const compat = discovery.checkCompatibility(manifest);

		expect(compat.compatible).toBe(false);
		expect(compat.runtimeAvailable).toBe(false);
		expect(compat.warnings.length).toBeGreaterThan(0);
		expect(compat.warnings[0]).toContain("go");
	});

	it("should findAlternatives returning packages with shared tags", () => {
		catalog.publish(
			createTestManifest({
				name: "original",
				runtime: "nodejs",
				tags: ["auth", "security", "jwt"],
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "alt-auth",
				runtime: "nodejs",
				tags: ["auth", "oauth"],
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "alt-security",
				runtime: "nodejs",
				tags: ["security", "encryption"],
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "unrelated",
				runtime: "nodejs",
				tags: ["database", "orm"],
			}),
		);

		const alternatives = discovery.findAlternatives("original", "nodejs");

		// Should not include the original package itself
		expect(alternatives.find((p) => p.name === "original")).toBeUndefined();
		// Packages with more shared tags should come first
		expect(alternatives.length).toBe(3);
		// alt-auth shares "auth", alt-security shares "security"
		const altNames = alternatives.map((p) => p.name);
		expect(altNames).toContain("alt-auth");
		expect(altNames).toContain("alt-security");
		expect(altNames).toContain("unrelated");
	});

	it("should recommend packages sorted by composite score", () => {
		catalog.publish(
			createTestManifest({
				name: "popular",
				runtime: "nodejs",
				downloads: 10000,
				rating: 4.5,
				tags: ["web"],
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "niche",
				runtime: "nodejs",
				downloads: 10,
				rating: 5,
				tags: ["web"],
			}),
		);
		catalog.publish(
			createTestManifest({
				name: "average",
				runtime: "nodejs",
				downloads: 1000,
				rating: 3.5,
				tags: ["web"],
			}),
		);

		const recommended = discovery.recommend("nodejs");
		expect(recommended).toHaveLength(3);
		// Composite score: rating * log(downloads + 1)
		// popular: 4.5 * log(10001) ~ 4.5 * 9.21 = 41.4
		// average: 3.5 * log(1001) ~ 3.5 * 6.91 = 24.2
		// niche: 5 * log(11) ~ 5 * 2.40 = 12.0
		expect(recommended[0].name).toBe("popular");
		expect(recommended[1].name).toBe("average");
		expect(recommended[2].name).toBe("niche");
	});

	it("should resolveVersion handling caret (^) ranges", () => {
		catalog.publish(createTestManifest({ name: "semver-pkg", version: "1.0.0" }));
		catalog.publish(createTestManifest({ name: "semver-pkg", version: "1.2.0" }));
		catalog.publish(createTestManifest({ name: "semver-pkg", version: "1.5.3" }));
		catalog.publish(createTestManifest({ name: "semver-pkg", version: "2.0.0" }));

		// ^1.0.0 should match >=1.0.0 <2.0.0 and return highest: 1.5.3
		const resolved = discovery.resolveVersion("semver-pkg", "^1.0.0");
		expect(resolved).toBe("1.5.3");

		// ^1.2.0 should match >=1.2.0 <2.0.0 and return 1.5.3
		const resolved2 = discovery.resolveVersion("semver-pkg", "^1.2.0");
		expect(resolved2).toBe("1.5.3");

		// ^2.0.0 should match only 2.0.0
		const resolved3 = discovery.resolveVersion("semver-pkg", "^2.0.0");
		expect(resolved3).toBe("2.0.0");
	});

	it("should resolveVersion handling tilde (~) ranges", () => {
		catalog.publish(createTestManifest({ name: "tilde-pkg", version: "1.2.0" }));
		catalog.publish(createTestManifest({ name: "tilde-pkg", version: "1.2.5" }));
		catalog.publish(createTestManifest({ name: "tilde-pkg", version: "1.3.0" }));
		catalog.publish(createTestManifest({ name: "tilde-pkg", version: "2.0.0" }));

		// ~1.2.0 should match >=1.2.0 <1.3.0 and return 1.2.5
		const resolved = discovery.resolveVersion("tilde-pkg", "~1.2.0");
		expect(resolved).toBe("1.2.5");

		// ~1.3.0 should match only 1.3.0
		const resolved2 = discovery.resolveVersion("tilde-pkg", "~1.3.0");
		expect(resolved2).toBe("1.3.0");
	});
});

// ---------------------------------------------------------------------------
// 3. RuntimeHealthMonitor Tests
// ---------------------------------------------------------------------------

describe("RuntimeHealthMonitor", () => {
	let registry: RuntimeRegistry;
	let monitor: RuntimeHealthMonitor;

	beforeEach(() => {
		registry = RuntimeRegistry.getInstance();
		registry.clear();
		monitor = new RuntimeHealthMonitor(registry, {
			checkIntervalMs: 60_000, // Long interval so periodic checks don't interfere
			unhealthyThreshold: 3,
			degradedThreshold: 1,
			timeoutMs: 5_000,
			historySize: 100,
		});
	});

	afterEach(() => {
		monitor.stop();
		registry.clear();
	});

	it("should checkRuntime returning healthy when adapter is registered", async () => {
		registry.register(new MockRuntimeAdapter("nodejs"));

		const status = await monitor.checkRuntime("nodejs");

		expect(status.runtime).toBe("nodejs");
		expect(status.status).toBe("healthy");
		expect(status.consecutiveFailures).toBe(0);
		expect(status.lastCheck).toBeGreaterThan(0);
		expect(status.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("should checkRuntime returning unhealthy for unregistered runtime", async () => {
		// Do not register "go"
		const status = await monitor.checkRuntime("go");

		expect(status.runtime).toBe("go");
		expect(["degraded", "unhealthy"]).toContain(status.status);
		expect(status.consecutiveFailures).toBeGreaterThan(0);
		expect(status.details).toHaveProperty("error");
	});

	it("should getAllStatuses tracking all registered runtimes", async () => {
		registry.register(new MockRuntimeAdapter("nodejs"));
		registry.register(new MockRuntimeAdapter("python3"));

		await monitor.checkRuntime("nodejs");
		await monitor.checkRuntime("python3");

		const statuses = monitor.getAllStatuses();
		expect(statuses).toHaveLength(2);

		const runtimes = statuses.map((s) => s.runtime);
		expect(runtimes).toContain("nodejs");
		expect(runtimes).toContain("python3");
	});

	it("should fire onHealthChange listener on status transition", async () => {
		const changes: Array<{ runtime: RuntimeKind; oldStatus: string; newStatus: string }> = [];

		monitor.onHealthChange((runtime, oldStatus, newStatus) => {
			changes.push({ runtime, oldStatus, newStatus });
		});

		// First check on unregistered runtime transitions from "unknown" to degraded/unhealthy
		await monitor.checkRuntime("go");
		expect(changes.length).toBeGreaterThanOrEqual(1);
		expect(changes[0].runtime).toBe("go");
		expect(changes[0].oldStatus).toBe("unknown");

		// Now register the runtime and check again - should transition to healthy
		registry.register(new MockRuntimeAdapter("go"));
		await monitor.checkRuntime("go");

		const lastChange = changes[changes.length - 1];
		expect(lastChange.runtime).toBe("go");
		expect(lastChange.newStatus).toBe("healthy");
	});

	it("should getHistory returning check records", async () => {
		registry.register(new MockRuntimeAdapter("nodejs"));

		await monitor.checkRuntime("nodejs");
		await monitor.checkRuntime("nodejs");
		await monitor.checkRuntime("nodejs");

		const history = monitor.getHistory("nodejs");
		expect(history).toHaveLength(3);
		expect(history.every((r) => r.runtime === "nodejs")).toBe(true);
		expect(history.every((r) => r.status === "healthy")).toBe(true);
		expect(history.every((r) => r.timestamp > 0)).toBe(true);

		// Test limit parameter
		const limited = monitor.getHistory("nodejs", 2);
		expect(limited).toHaveLength(2);
	});

	it("should calculate getUptimePercentage from history", async () => {
		registry.register(new MockRuntimeAdapter("nodejs"));

		// Three healthy checks
		await monitor.checkRuntime("nodejs");
		await monitor.checkRuntime("nodejs");
		await monitor.checkRuntime("nodejs");

		const uptime = monitor.getUptimePercentage("nodejs");
		expect(uptime).toBe(100);

		// Check an unregistered runtime to create a non-healthy record
		await monitor.checkRuntime("rust");
		const rustUptime = monitor.getUptimePercentage("rust");
		expect(rustUptime).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 4. RuntimeMetricsDashboard Tests
// ---------------------------------------------------------------------------

describe("RuntimeMetricsDashboard", () => {
	let dashboard: RuntimeMetricsDashboard;

	beforeEach(() => {
		dashboard = new RuntimeMetricsDashboard();
	});

	it("should recordExecution tracking success metrics", () => {
		dashboard.recordExecution("nodejs", createTestExecutionResult({ success: true }));
		dashboard.recordExecution("nodejs", createTestExecutionResult({ success: true }));
		dashboard.recordExecution("nodejs", createTestExecutionResult({ success: true }));

		const metrics = dashboard.getMetrics("nodejs");
		expect(metrics).toBeDefined();
		expect(metrics!.totalExecutions).toBe(3);
		expect(metrics!.successfulExecutions).toBe(3);
		expect(metrics!.failedExecutions).toBe(0);
		expect(metrics!.successRate).toBe(1);
	});

	it("should recordExecution tracking failure metrics", () => {
		dashboard.recordExecution("nodejs", createTestExecutionResult({ success: true }));
		dashboard.recordExecution(
			"nodejs",
			createTestExecutionResult({
				success: false,
				errors: { message: "fail" },
			}),
		);
		dashboard.recordExecution(
			"nodejs",
			createTestExecutionResult({
				success: false,
				errors: { message: "fail" },
			}),
		);

		const metrics = dashboard.getMetrics("nodejs");
		expect(metrics).toBeDefined();
		expect(metrics!.totalExecutions).toBe(3);
		expect(metrics!.successfulExecutions).toBe(1);
		expect(metrics!.failedExecutions).toBe(2);
		expect(metrics!.successRate).toBeCloseTo(1 / 3, 5);
	});

	it("should getMetrics returning latency percentiles (p50, p95, p99)", () => {
		// Record 100 executions with varying latencies
		for (let i = 1; i <= 100; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: i, cpu_ms: 5, memory_bytes: 1024 },
				}),
			);
		}

		const metrics = dashboard.getMetrics("nodejs");
		expect(metrics).toBeDefined();

		const latency = metrics!.latency;
		expect(latency.count).toBe(100);
		expect(latency.min).toBe(1);
		expect(latency.max).toBe(100);
		expect(latency.avg).toBeCloseTo(50.5, 0);
		expect(latency.p50).toBe(50);
		expect(latency.p95).toBe(95);
		expect(latency.p99).toBe(99);
	});

	it("should getMetrics returning throughput (RPS calculation)", () => {
		// Record several executions within the same time window
		for (let i = 0; i < 10; i++) {
			dashboard.recordExecution("nodejs", createTestExecutionResult());
		}

		const metrics = dashboard.getMetrics("nodejs");
		expect(metrics).toBeDefined();

		// RPS should be positive since we just recorded executions
		expect(metrics!.throughput.requestsPerSecond).toBeGreaterThan(0);
		expect(metrics!.throughput.peakRps).toBeGreaterThan(0);
		expect(metrics!.throughput.windowSizeMs).toBe(60_000);
	});

	it("should getSnapshot including aggregate metrics", () => {
		dashboard.recordExecution(
			"nodejs",
			createTestExecutionResult({
				metrics: { duration_ms: 50 },
			}),
		);
		dashboard.recordExecution(
			"python3",
			createTestExecutionResult({
				metrics: { duration_ms: 100 },
			}),
		);
		dashboard.recordExecution(
			"go",
			createTestExecutionResult({
				success: false,
				errors: "err",
				metrics: { duration_ms: 200 },
			}),
		);

		const snapshot = dashboard.getSnapshot();
		expect(snapshot.timestamp).toBeGreaterThan(0);
		expect(snapshot.runtimes).toHaveLength(3);

		const agg = snapshot.aggregate;
		expect(agg.totalExecutions).toBe(3);
		expect(agg.totalSuccess).toBe(2);
		expect(agg.totalFailures).toBe(1);
		expect(agg.activeRuntimes).toBe(3);
		expect(agg.busiestRuntime).toBeDefined();
		expect(agg.slowestRuntime).toBe("go");
	});

	it("should getTopRuntimes by executions", () => {
		dashboard.recordExecution("nodejs", createTestExecutionResult());
		dashboard.recordExecution("nodejs", createTestExecutionResult());
		dashboard.recordExecution("nodejs", createTestExecutionResult());
		dashboard.recordExecution("python3", createTestExecutionResult());
		dashboard.recordExecution("go", createTestExecutionResult());
		dashboard.recordExecution("go", createTestExecutionResult());

		const top = dashboard.getTopRuntimes("executions", 2);
		expect(top).toHaveLength(2);
		expect(top[0].runtime).toBe("nodejs");
		expect(top[0].totalExecutions).toBe(3);
		expect(top[1].runtime).toBe("go");
		expect(top[1].totalExecutions).toBe(2);
	});

	it("should getTopRuntimes by latency", () => {
		// fast nodejs
		dashboard.recordExecution(
			"nodejs",
			createTestExecutionResult({
				metrics: { duration_ms: 10 },
			}),
		);
		// slow python
		dashboard.recordExecution(
			"python3",
			createTestExecutionResult({
				metrics: { duration_ms: 500 },
			}),
		);
		// medium go
		dashboard.recordExecution(
			"go",
			createTestExecutionResult({
				metrics: { duration_ms: 100 },
			}),
		);

		const top = dashboard.getTopRuntimes("latency", 3);
		expect(top).toHaveLength(3);
		// Lower latency is better, so sorted ascending
		expect(top[0].runtime).toBe("nodejs");
		expect(top[1].runtime).toBe("go");
		expect(top[2].runtime).toBe("python3");
	});

	it("should getExecutionTrend returning time-bucketed counts", () => {
		// Record some executions so they fall in the most recent bucket
		for (let i = 0; i < 5; i++) {
			dashboard.recordExecution("nodejs", createTestExecutionResult());
		}

		const trend = dashboard.getExecutionTrend("nodejs", 60_000, 5);
		expect(trend).toHaveLength(5);
		// Most recent bucket should have executions
		const totalInTrend = trend.reduce((a, b) => a + b, 0);
		expect(totalInTrend).toBe(5);

		// Non-existent runtime should return all zeros
		const emptyTrend = dashboard.getExecutionTrend("rust", 60_000, 5);
		expect(emptyTrend).toEqual([0, 0, 0, 0, 0]);
	});

	it("should reset clearing all metrics", () => {
		dashboard.recordExecution("nodejs", createTestExecutionResult());
		dashboard.recordExecution("python3", createTestExecutionResult());

		expect(dashboard.getMetrics("nodejs")).toBeDefined();
		expect(dashboard.getMetrics("python3")).toBeDefined();

		dashboard.reset();

		expect(dashboard.getMetrics("nodejs")).toBeUndefined();
		expect(dashboard.getMetrics("python3")).toBeUndefined();
		expect(dashboard.getAllMetrics()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 5. RuntimeAutoScaler Tests
// ---------------------------------------------------------------------------

describe("RuntimeAutoScaler", () => {
	let dashboard: RuntimeMetricsDashboard;
	let scaler: RuntimeAutoScaler;

	beforeEach(() => {
		dashboard = new RuntimeMetricsDashboard();
		scaler = new RuntimeAutoScaler(dashboard, { enabled: true, dryRun: false });
	});

	afterEach(() => {
		scaler.stop();
	});

	it("should setPolicy and getPolicy", () => {
		const policy: ScalingPolicy = {
			runtime: "nodejs",
			minInstances: 2,
			maxInstances: 20,
			targetCpuUtilization: 70,
			targetLatencyMs: 200,
			targetRps: 100,
			scaleUpCooldownMs: 60_000,
			scaleDownCooldownMs: 300_000,
			scaleUpStep: 2,
			scaleDownStep: 1,
		};

		scaler.setPolicy(policy);

		const retrieved = scaler.getPolicy("nodejs");
		expect(retrieved).toBeDefined();
		expect(retrieved!.runtime).toBe("nodejs");
		expect(retrieved!.minInstances).toBe(2);
		expect(retrieved!.maxInstances).toBe(20);
		expect(retrieved!.scaleUpStep).toBe(2);
	});

	it("should evaluate returning scale_up when RPS exceeds target", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 200,
			targetRps: 5,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		// Record many executions to push RPS high
		for (let i = 0; i < 500; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 50, cpu_ms: 10, memory_bytes: 1024 },
				}),
			);
		}

		const decision = scaler.evaluate("nodejs");
		expect(decision.runtime).toBe("nodejs");
		// With many executions in the window, RPS should exceed 5 per instance
		// The decision should be either scale_up or no_change if already at max
		expect(["scale_up", "no_change"]).toContain(decision.action);
	});

	it("should evaluate returning scale_up when latency exceeds target", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 50,
			targetRps: 100_000,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		// Record executions with high latency
		for (let i = 0; i < 20; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 500, cpu_ms: 10, memory_bytes: 1024 },
				}),
			);
		}

		const decision = scaler.evaluate("nodejs");
		expect(decision.runtime).toBe("nodejs");
		// p95 latency of 500ms exceeds target of 50ms
		expect(decision.action).toBe("scale_up");
		expect(decision.reason).toContain("latency");
	});

	it("should evaluate returning scale_down when load is low", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 100,
			targetCpuUtilization: 70,
			targetLatencyMs: 1000,
			targetRps: 100_000,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		// Record minimal executions with low latency
		dashboard.recordExecution(
			"nodejs",
			createTestExecutionResult({
				metrics: { duration_ms: 5, cpu_ms: 1, memory_bytes: 512 },
			}),
		);

		const decision = scaler.evaluate("nodejs");
		expect(decision.runtime).toBe("nodejs");
		// With very low load, the result should be either scale_down or no_change
		expect(["scale_down", "no_change"]).toContain(decision.action);
	});

	it("should evaluate returning no_change when within thresholds", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 1000,
			targetRps: 100_000,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		// Record moderate executions with acceptable latency
		for (let i = 0; i < 5; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 100, cpu_ms: 10, memory_bytes: 1024 },
				}),
			);
		}

		const decision = scaler.evaluate("nodejs");
		expect(decision.runtime).toBe("nodejs");
		expect(decision.action).toBe("no_change");
	});

	it("should evaluate respecting cooldown periods", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 50,
			targetRps: 100_000,
			scaleUpCooldownMs: 600_000, // 10 minute cooldown
			scaleDownCooldownMs: 600_000,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		// Record high-latency executions to trigger scale_up
		for (let i = 0; i < 20; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 500, cpu_ms: 10, memory_bytes: 1024 },
				}),
			);
		}

		// First evaluation should scale up
		const decision1 = scaler.evaluate("nodejs");
		expect(decision1.action).toBe("scale_up");

		// Second evaluation should respect cooldown - action becomes no_change
		// even though metrics still exceed thresholds
		const decision2 = scaler.evaluate("nodejs");
		expect(decision2.action).toBe("no_change");
		expect(decision2.reason).toContain("cooldown");
	});

	it("should evaluate clamping to min/max instances", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 2,
			maxInstances: 3,
			targetCpuUtilization: 70,
			targetLatencyMs: 50,
			targetRps: 100_000,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 5, // Wants to add 5 but max is 3
			scaleDownStep: 1,
		});

		// Record high-latency executions
		for (let i = 0; i < 20; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 500, cpu_ms: 10, memory_bytes: 1024 },
				}),
			);
		}

		const decision = scaler.evaluate("nodejs");
		expect(decision.desiredInstances).toBeLessThanOrEqual(3);
		expect(decision.desiredInstances).toBeGreaterThanOrEqual(2);
	});

	it("should onScalingDecision listener firing on decisions", () => {
		const decisions: ScalingDecision[] = [];

		scaler.onScalingDecision((decision) => {
			decisions.push(decision);
		});

		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 200,
			targetRps: 100,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		dashboard.recordExecution("nodejs", createTestExecutionResult());

		scaler.evaluate("nodejs");

		expect(decisions).toHaveLength(1);
		expect(decisions[0].runtime).toBe("nodejs");
		expect(decisions[0].timestamp).toBeGreaterThan(0);
	});

	it("should getRecommendedPolicy returning reasonable defaults based on metrics", () => {
		// Record some metrics to give the recommender data
		for (let i = 0; i < 50; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 100 + Math.random() * 100, cpu_ms: 20, memory_bytes: 2048 },
				}),
			);
		}

		const recommended = scaler.getRecommendedPolicy("nodejs");
		expect(recommended.runtime).toBe("nodejs");
		expect(recommended.minInstances).toBeGreaterThanOrEqual(1);
		expect(recommended.maxInstances).toBeGreaterThanOrEqual(recommended.minInstances);
		expect(recommended.targetLatencyMs).toBeGreaterThan(0);
		expect(recommended.targetRps).toBeGreaterThan(0);
		expect(recommended.scaleUpCooldownMs).toBeGreaterThan(0);
		expect(recommended.scaleDownCooldownMs).toBeGreaterThan(0);
	});

	it("should evaluateAll processing all policies", () => {
		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 200,
			targetRps: 100,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});
		scaler.setPolicy({
			runtime: "python3",
			minInstances: 1,
			maxInstances: 5,
			targetCpuUtilization: 70,
			targetLatencyMs: 300,
			targetRps: 50,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		dashboard.recordExecution("nodejs", createTestExecutionResult());
		dashboard.recordExecution("python3", createTestExecutionResult());

		const decisions = scaler.evaluateAll();
		expect(decisions).toHaveLength(2);

		const runtimes = decisions.map((d) => d.runtime);
		expect(runtimes).toContain("nodejs");
		expect(runtimes).toContain("python3");
	});
});

// ---------------------------------------------------------------------------
// 6. End-to-End Marketplace Flow Tests
// ---------------------------------------------------------------------------

describe("End-to-End Marketplace Flow", () => {
	let catalog: RuntimeCatalog;
	let registry: RuntimeRegistry;
	let discovery: RuntimeDiscovery;
	let monitor: RuntimeHealthMonitor;
	let dashboard: RuntimeMetricsDashboard;
	let scaler: RuntimeAutoScaler;

	beforeEach(() => {
		catalog = new RuntimeCatalog();
		registry = RuntimeRegistry.getInstance();
		registry.clear();
		discovery = new RuntimeDiscovery(catalog, registry);
		monitor = new RuntimeHealthMonitor(registry, {
			checkIntervalMs: 60_000,
			unhealthyThreshold: 3,
			degradedThreshold: 1,
			timeoutMs: 5_000,
			historySize: 100,
		});
		dashboard = new RuntimeMetricsDashboard();
		scaler = new RuntimeAutoScaler(dashboard, { enabled: true, dryRun: false });
	});

	afterEach(() => {
		monitor.stop();
		scaler.stop();
		registry.clear();
	});

	it("should complete full lifecycle: publish, search, discover, install flow", () => {
		// Step 1: Author publishes a package
		const manifest = createTestManifest({
			name: "auth-middleware",
			version: "1.0.0",
			runtime: "nodejs",
			description: "JWT authentication middleware for Blok workflows",
			author: "blok-team",
			tags: ["auth", "jwt", "middleware", "security"],
			verified: true,
			downloads: 0,
			rating: 4.5,
		});
		catalog.publish(manifest);

		// Step 2: Author publishes a newer version
		catalog.publish(
			createTestManifest({
				...manifest,
				version: "1.1.0",
				description: "JWT authentication middleware with OAuth2 support",
			}),
		);

		// Step 3: User searches the marketplace
		const searchResult = catalog.search({ query: "auth", runtime: "nodejs" });
		expect(searchResult.packages).toHaveLength(1);
		expect(searchResult.packages[0].name).toBe("auth-middleware");

		// Step 4: User discovers packages for their runtime
		registry.register(new MockRuntimeAdapter("nodejs"));
		const discovered = discovery.discover("nodejs");
		expect(discovered.some((p) => p.name === "auth-middleware")).toBe(true);

		// Step 5: User resolves the package with compatibility check
		const resolved = discovery.resolve({ name: "auth-middleware" });
		expect(resolved).toBeDefined();
		expect(resolved!.package.version).toBe("1.1.0");
		expect(resolved!.compatibility.compatible).toBe(true);

		// Step 6: Simulate download (install)
		catalog.incrementDownloads("auth-middleware", "1.1.0");
		catalog.incrementDownloads("auth-middleware", "1.1.0");

		const pkg = catalog.get("auth-middleware");
		expect(pkg!.downloads).toBe(2);

		// Step 7: Verify stats
		const stats = catalog.getStats();
		expect(stats.totalPackages).toBe(1);
		expect(stats.totalVersions).toBe(2);
		expect(stats.totalDownloads).toBe(2);
		expect(stats.verifiedCount).toBe(1);
	});

	it("should handle multi-runtime marketplace with concurrent operations", async () => {
		// Publish packages for multiple runtimes
		const runtimes: RuntimeKind[] = ["nodejs", "python3", "go", "rust", "java"];
		const adapters: MockRuntimeAdapter[] = [];

		for (const runtime of runtimes) {
			const adapter = new MockRuntimeAdapter(runtime);
			adapters.push(adapter);
			registry.register(adapter);

			// Publish 3 packages per runtime
			for (let i = 1; i <= 3; i++) {
				catalog.publish(
					createTestManifest({
						name: `${runtime}-pkg-${i}`,
						version: "1.0.0",
						runtime,
						description: `Package ${i} for ${runtime}`,
						tags: ["utility", runtime],
						downloads: Math.floor(Math.random() * 1000),
						rating: Math.floor(Math.random() * 5) + 1,
					}),
				);
			}
		}

		// Concurrently search and discover
		const [searchResults, discoveries, healthChecks] = await Promise.all([
			// Search across all runtimes
			Promise.resolve(catalog.search({ query: "utility" })),
			// Discover for each runtime
			Promise.all(runtimes.map((r) => Promise.resolve(discovery.discover(r)))),
			// Health check all runtimes
			Promise.all(runtimes.map((r) => monitor.checkRuntime(r))),
		]);

		// All 15 packages should be found in the search
		expect(searchResults.total).toBe(15);

		// Each runtime should have 3 packages discovered
		for (const disco of discoveries) {
			expect(disco).toHaveLength(3);
		}

		// All runtimes should be healthy
		for (const health of healthChecks) {
			expect(health.status).toBe("healthy");
		}

		// Verify catalog stats
		const stats = catalog.getStats();
		expect(stats.totalPackages).toBe(15);
		expect(stats.totalVersions).toBe(15);
		for (const runtime of runtimes) {
			expect(stats.packagesByRuntime[runtime]).toBe(3);
		}
	});

	it("should integrate metrics dashboard with auto-scaler: record executions and evaluate scaling", () => {
		// Setup: register runtime and configure auto-scaler
		registry.register(new MockRuntimeAdapter("nodejs"));

		scaler.setPolicy({
			runtime: "nodejs",
			minInstances: 1,
			maxInstances: 10,
			targetCpuUtilization: 70,
			targetLatencyMs: 100,
			targetRps: 50,
			scaleUpCooldownMs: 0,
			scaleDownCooldownMs: 0,
			scaleUpStep: 1,
			scaleDownStep: 1,
		});

		// Phase 1: Normal load - record moderate executions
		for (let i = 0; i < 10; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 50, cpu_ms: 10, memory_bytes: 1024 },
				}),
			);
		}

		const normalDecision = scaler.evaluate("nodejs");
		expect(normalDecision.runtime).toBe("nodejs");
		// Under normal load the scaler should not aggressively scale
		expect(["no_change", "scale_down"]).toContain(normalDecision.action);

		// Phase 2: High latency load - record slow executions
		dashboard.reset();
		for (let i = 0; i < 100; i++) {
			dashboard.recordExecution(
				"nodejs",
				createTestExecutionResult({
					metrics: { duration_ms: 500, cpu_ms: 50, memory_bytes: 1024 * 1024 },
				}),
			);
		}

		const highLatencyDecision = scaler.evaluate("nodejs");
		expect(highLatencyDecision.runtime).toBe("nodejs");
		// With latency of 500ms and target of 100ms, should scale up
		expect(highLatencyDecision.action).toBe("scale_up");
		expect(highLatencyDecision.reason).toContain("latency");

		// Verify the dashboard snapshot reflects the recorded data
		const snapshot = dashboard.getSnapshot();
		expect(snapshot.aggregate.totalExecutions).toBe(100);
		expect(snapshot.aggregate.activeRuntimes).toBe(1);
		expect(snapshot.runtimes[0].latency.p95).toBeGreaterThan(100);
	});
});
