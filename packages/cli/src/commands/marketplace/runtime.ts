import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as p from "@clack/prompts";

import type {
	RuntimePackageManifest,
	CatalogSearchOptions,
	CatalogStats,
	RuntimeKind,
} from "@nanoservice-ts/runner";

import { Command, type OptionValues, trackCommandExecution } from "../../services/commander.js";
import { tokenManager } from "../../services/local-token-manager.js";

export interface MarketplaceConfig {
	registryUrl: string;
	cacheDir: string;
	cacheTtlMs: number;
}

export interface MarketplaceListOptions {
	runtime?: RuntimeKind;
	query?: string;
	tags?: string[];
	verified?: boolean;
	sortBy?: "name" | "downloads" | "rating" | "updated";
	limit?: number;
	format?: "table" | "json";
}

export interface MarketplaceInstallOptions {
	name: string;
	version?: string;
	runtime?: RuntimeKind;
	force?: boolean;
}

export interface MarketplacePublishOptions {
	manifestPath: string;
	dockerImage: string;
	runtime: RuntimeKind;
	tags?: string[];
	description?: string;
}

interface CacheEntry {
	timestamp: number;
	data: RuntimePackageManifest[];
}

const DEFAULT_REGISTRY_URL = "https://marketplace.blok.dev/api/v1";
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".blok", "marketplace-cache");
const DEFAULT_CACHE_TTL_MS = 3_600_000; // 1 hour

export class RuntimeMarketplaceCommand {
	private config: MarketplaceConfig;

	constructor(config?: Partial<MarketplaceConfig>) {
		this.config = {
			registryUrl: config?.registryUrl ?? process.env.BLOK_MARKETPLACE_URL ?? DEFAULT_REGISTRY_URL,
			cacheDir: config?.cacheDir ?? DEFAULT_CACHE_DIR,
			cacheTtlMs: config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
		};

		// Ensure cache directory exists
		if (!fs.existsSync(this.config.cacheDir)) {
			fs.mkdirSync(this.config.cacheDir, { recursive: true });
		}
	}

	/**
	 * Search the marketplace for runtime packages matching the given options.
	 * Results are cached locally to reduce API calls.
	 *
	 * @param options - Search and filter options
	 * @returns Array of matching runtime package manifests
	 */
	async search(options: MarketplaceListOptions): Promise<RuntimePackageManifest[]> {
		const cacheKey = this.getCacheKey(options);
		const cached = this.readCache(cacheKey);

		if (cached) {
			return cached;
		}

		const searchOptions: CatalogSearchOptions = {
			query: options.query,
			runtime: options.runtime,
			tags: options.tags,
			verified: options.verified,
			sortBy: options.sortBy,
			limit: options.limit,
		};

		const params: Record<string, string> = {};
		if (searchOptions.query) params.query = searchOptions.query;
		if (searchOptions.runtime) params.runtime = searchOptions.runtime;
		if (searchOptions.tags && searchOptions.tags.length > 0) params.tags = searchOptions.tags.join(",");
		if (searchOptions.verified !== undefined) params.verified = String(searchOptions.verified);
		if (searchOptions.sortBy) params.sortBy = searchOptions.sortBy;
		if (searchOptions.limit) params.limit = String(searchOptions.limit);

		const result = await this.fetchFromApi<{ packages: RuntimePackageManifest[] }>("/packages/search", params);
		const packages = result.packages;

		this.writeCache(cacheKey, packages);

		return packages;
	}

	/**
	 * Install a runtime package from the marketplace.
	 *
	 * Steps:
	 * 1. Resolve version (latest if not specified)
	 * 2. Fetch package manifest
	 * 3. Pull Docker image if specified
	 * 4. Register in local catalog
	 * 5. Return success/failure
	 *
	 * @param options - Install options including package name, version, and runtime
	 * @returns Result object with success status and message
	 */
	async install(options: MarketplaceInstallOptions): Promise<{ success: boolean; message: string }> {
		try {
			// Step 1: Resolve version
			let version = options.version;
			if (!version) {
				const versionInfo = await this.fetchFromApi<{ latest: string }>(
					`/packages/${encodeURIComponent(options.name)}/versions/latest`,
				);
				version = versionInfo.latest;
			}

			// Step 2: Fetch package manifest
			const manifest = await this.fetchFromApi<RuntimePackageManifest>(
				`/packages/${encodeURIComponent(options.name)}/versions/${encodeURIComponent(version)}`,
			);

			// Validate runtime if specified
			if (options.runtime && manifest.runtime !== options.runtime) {
				return {
					success: false,
					message: `Package "${options.name}" is for runtime "${manifest.runtime}", not "${options.runtime}".`,
				};
			}

			// Step 3: Pull Docker image if specified
			if (manifest.dockerImage) {
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const execAsync = promisify(exec);

				const pullCommand = options.force
					? `docker pull --force ${manifest.dockerImage}`
					: `docker pull ${manifest.dockerImage}`;

				try {
					await execAsync(pullCommand);
				} catch (dockerError) {
					return {
						success: false,
						message: `Failed to pull Docker image "${manifest.dockerImage}": ${(dockerError as Error).message}`,
					};
				}
			}

			// Step 4: Register in local catalog
			const catalogDir = path.join(os.homedir(), ".blok", "catalog");
			if (!fs.existsSync(catalogDir)) {
				fs.mkdirSync(catalogDir, { recursive: true });
			}

			const catalogFile = path.join(catalogDir, "installed.json");
			let catalog: Record<string, RuntimePackageManifest> = {};

			if (fs.existsSync(catalogFile)) {
				catalog = JSON.parse(fs.readFileSync(catalogFile, "utf-8"));
			}

			const catalogKey = `${manifest.name}@${manifest.version}`;

			if (catalog[catalogKey] && !options.force) {
				return {
					success: false,
					message: `Package "${catalogKey}" is already installed. Use --force to reinstall.`,
				};
			}

			catalog[catalogKey] = manifest;
			fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2), "utf-8");

			// Step 5: Return success
			return {
				success: true,
				message: `Successfully installed ${manifest.name}@${manifest.version} (${manifest.runtime} runtime).`,
			};
		} catch (error) {
			return {
				success: false,
				message: `Failed to install "${options.name}": ${(error as Error).message}`,
			};
		}
	}

	/**
	 * Publish a runtime package to the marketplace.
	 *
	 * Steps:
	 * 1. Read and validate manifest file
	 * 2. Build RuntimePackageManifest
	 * 3. Upload to marketplace API
	 * 4. Return success with package ID
	 *
	 * @param options - Publish options including manifest path, Docker image, and runtime
	 * @returns Result object with success status, package ID, and version
	 */
	async publish(
		options: MarketplacePublishOptions,
	): Promise<{ success: boolean; packageId: string; version: string }> {
		try {
			// Step 1: Read and validate manifest file
			const manifestPath = path.resolve(options.manifestPath);

			if (!fs.existsSync(manifestPath)) {
				return {
					success: false,
					packageId: "",
					version: "",
				};
			}

			const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

			// Step 2: Build RuntimePackageManifest
			const manifest: RuntimePackageManifest = {
				name: rawManifest.name,
				version: rawManifest.version,
				runtime: options.runtime,
				description: options.description ?? rawManifest.description ?? "",
				author: rawManifest.author ?? "",
				license: rawManifest.license ?? "MIT",
				repository: rawManifest.repository,
				tags: options.tags ?? rawManifest.tags ?? [],
				protocols: rawManifest.protocols ?? ["http"],
				dockerImage: options.dockerImage,
				minBlokVersion: rawManifest.minBlokVersion,
				nodeCount: rawManifest.nodes?.length ?? 0,
				nodes: rawManifest.nodes ?? [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				downloads: 0,
				rating: 0,
				verified: false,
			};

			// Validate required fields
			if (!manifest.name) {
				return { success: false, packageId: "", version: "" };
			}
			if (!manifest.version) {
				return { success: false, packageId: "", version: "" };
			}

			// Step 3: Upload to marketplace API
			const token = tokenManager.getToken();
			if (!token) {
				return { success: false, packageId: "", version: "" };
			}

			const response = await fetch(`${this.config.registryUrl}/packages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(manifest),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`API error (${response.status}): ${errorText}`);
			}

			const result = await response.json();

			// Step 4: Return success with package ID
			return {
				success: true,
				packageId: result.packageId ?? manifest.name,
				version: manifest.version,
			};
		} catch (error) {
			return {
				success: false,
				packageId: "",
				version: "",
			};
		}
	}

	/**
	 * Get detailed information for a specific package.
	 *
	 * @param name - The package name
	 * @param version - Optional specific version (defaults to latest)
	 * @returns The package manifest if found, null otherwise
	 */
	async info(name: string, version?: string): Promise<RuntimePackageManifest | null> {
		try {
			const versionPath = version
				? `/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
				: `/packages/${encodeURIComponent(name)}`;

			return await this.fetchFromApi<RuntimePackageManifest>(versionPath);
		} catch {
			return null;
		}
	}

	/**
	 * Get overall marketplace statistics.
	 *
	 * @returns Catalog statistics including total packages, downloads, and ratings
	 */
	async stats(): Promise<CatalogStats> {
		return this.fetchFromApi<CatalogStats>("/stats");
	}

	/**
	 * List all packages for a specific runtime.
	 *
	 * @param runtime - The runtime kind to filter by
	 * @returns Array of package manifests for the given runtime
	 */
	async list(runtime: RuntimeKind): Promise<RuntimePackageManifest[]> {
		const params: Record<string, string> = { runtime };
		const result = await this.fetchFromApi<{ packages: RuntimePackageManifest[] }>("/packages", params);
		return result.packages;
	}

	/**
	 * Format an array of package manifests as an ASCII table.
	 *
	 * Columns: Name, Version, Runtime, Downloads, Rating, Verified, Description (truncated to 40 chars)
	 *
	 * @param packages - Array of package manifests to format
	 * @returns Formatted ASCII table string
	 */
	formatTable(packages: RuntimePackageManifest[]): string {
		if (packages.length === 0) {
			return "No packages found.";
		}

		const headers = ["Name", "Version", "Runtime", "Downloads", "Rating", "Verified", "Description"];

		const rows = packages.map((pkg) => [
			pkg.name,
			pkg.version,
			pkg.runtime,
			String(pkg.downloads),
			pkg.rating.toFixed(1),
			pkg.verified ? "Yes" : "No",
			pkg.description.length > 40 ? `${pkg.description.substring(0, 37)}...` : pkg.description,
		]);

		// Calculate column widths
		const colWidths = headers.map((header, index) => {
			const maxDataWidth = rows.reduce((max, row) => Math.max(max, row[index].length), 0);
			return Math.max(header.length, maxDataWidth);
		});

		// Build separator line
		const separator = `+-${colWidths.map((w) => "-".repeat(w)).join("-+-")}-+`;

		// Build header row
		const headerRow = `| ${headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ")} |`;

		// Build data rows
		const dataRows = rows.map((row) => `| ${row.map((cell, i) => cell.padEnd(colWidths[i])).join(" | ")} |`);

		return [separator, headerRow, separator, ...dataRows, separator].join("\n");
	}

	/**
	 * Format an array of package manifests as a JSON string.
	 *
	 * @param packages - Array of package manifests to format
	 * @returns Pretty-printed JSON string
	 */
	formatJson(packages: RuntimePackageManifest[]): string {
		return JSON.stringify(packages, null, 2);
	}

	/**
	 * Generate a deterministic cache key from marketplace list options.
	 */
	private getCacheKey(options: MarketplaceListOptions): string {
		const parts: string[] = [];

		if (options.runtime) parts.push(`runtime:${options.runtime}`);
		if (options.query) parts.push(`query:${options.query}`);
		if (options.tags && options.tags.length > 0) parts.push(`tags:${options.tags.sort().join(",")}`);
		if (options.verified !== undefined) parts.push(`verified:${options.verified}`);
		if (options.sortBy) parts.push(`sortBy:${options.sortBy}`);
		if (options.limit) parts.push(`limit:${options.limit}`);

		const key = parts.length > 0 ? parts.join("|") : "all";

		// Create a filesystem-safe hash from the key
		return hashToSafeFilename(key);
	}

	/**
	 * Read cached data for the given key if it exists and has not expired.
	 *
	 * @param key - The cache key
	 * @returns Cached packages array or null if not found or expired
	 */
	private readCache(key: string): RuntimePackageManifest[] | null {
		try {
			const cacheFile = path.join(this.config.cacheDir, `${key}.json`);

			if (!fs.existsSync(cacheFile)) {
				return null;
			}

			const raw = fs.readFileSync(cacheFile, "utf-8");
			const entry: CacheEntry = JSON.parse(raw);

			// Check if cache has expired
			if (Date.now() - entry.timestamp > this.config.cacheTtlMs) {
				// Cache expired, remove the file
				fs.unlinkSync(cacheFile);
				return null;
			}

			return entry.data;
		} catch {
			return null;
		}
	}

	/**
	 * Write data to the cache with the current timestamp.
	 *
	 * @param key - The cache key
	 * @param data - The packages data to cache
	 */
	private writeCache(key: string, data: RuntimePackageManifest[]): void {
		try {
			const cacheFile = path.join(this.config.cacheDir, `${key}.json`);
			const entry: CacheEntry = {
				timestamp: Date.now(),
				data,
			};

			fs.writeFileSync(cacheFile, JSON.stringify(entry), "utf-8");
		} catch {
			// Silently ignore cache write failures
		}
	}

	/**
	 * Fetch data from the marketplace API with error handling.
	 *
	 * @param apiPath - The API endpoint path
	 * @param params - Optional query parameters
	 * @returns The parsed response data
	 */
	private async fetchFromApi<T>(apiPath: string, params?: Record<string, string>): Promise<T> {
		const url = new URL(`${this.config.registryUrl}${apiPath}`);

		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}

		const token = tokenManager.getToken();
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}

		const response = await fetch(url.toString(), {
			method: "GET",
			headers,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Marketplace API error (${response.status}): ${errorText}`);
		}

		return (await response.json()) as T;
	}
}

/**
 * Create a filesystem-safe hash from a string key.
 * Uses a simple base36 encoding of a DJB2 hash to avoid crypto import overhead.
 */
function hashToSafeFilename(input: string): string {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		const char = input.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0; // Convert to 32-bit integer
	}
	return Math.abs(hash).toString(36);
}

// CLI command integration
export default new Command()
	.command("runtime")
	.description("Manage runtime packages from the Blok marketplace")
	.option("-r, --runtime <value>", "Filter by runtime kind (nodejs, python3, go, rust, etc.)")
	.option("-q, --query <value>", "Search query string")
	.option("-t, --tags <value>", "Comma-separated tags to filter by")
	.option("--verified", "Show only verified packages")
	.option("-s, --sort-by <value>", "Sort by: name, downloads, rating, updated", "downloads")
	.option("-l, --limit <value>", "Limit number of results", "20")
	.option("-f, --format <value>", "Output format: table or json", "table")
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "marketplace runtime",
			args: options,
			execution: async () => {
				const logger = p.spinner();

				try {
					logger.start("Searching marketplace for runtime packages...");

					const marketplace = new RuntimeMarketplaceCommand();

					const listOptions: MarketplaceListOptions = {
						runtime: options.runtime as RuntimeKind | undefined,
						query: options.query as string | undefined,
						tags: options.tags ? (options.tags as string).split(",") : undefined,
						verified: options.verified as boolean | undefined,
						sortBy: (options.sortBy as MarketplaceListOptions["sortBy"]) ?? "downloads",
						limit: options.limit ? Number.parseInt(options.limit as string, 10) : 20,
						format: (options.format as "table" | "json") ?? "table",
					};

					const packages = await marketplace.search(listOptions);

					if (packages.length === 0) {
						logger.stop("No packages found matching your criteria.");
						return;
					}

					const output =
						listOptions.format === "json"
							? marketplace.formatJson(packages)
							: marketplace.formatTable(packages);

					logger.stop(`Found ${packages.length} package(s):\n\n${output}`);
				} catch (error) {
					logger.stop((error as Error).message, 1);
				}
			},
		});
	});
