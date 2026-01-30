/**
 * RuntimeCatalog - Central Registry for Runtime Packages
 *
 * Manages runtime package metadata, search, versioning, and statistics
 * for the Blok marketplace. Supports publishing, discovery, and filtering
 * of runtime packages across all supported language runtimes.
 */

import type { RuntimeKind } from "../adapters/RuntimeAdapter";

export interface RuntimeNodeInfo {
	name: string;
	description: string;
	inputs: Record<string, string>;
	outputs: Record<string, string>;
}

export interface RuntimePackageManifest {
	name: string;
	version: string;
	runtime: RuntimeKind;
	description: string;
	author: string;
	license: string;
	repository?: string;
	tags: string[];
	protocols: ("http" | "grpc" | "both")[];
	dockerImage?: string;
	minBlokVersion?: string;
	nodeCount: number;
	nodes: RuntimeNodeInfo[];
	createdAt: number;
	updatedAt: number;
	downloads: number;
	rating: number;
	verified: boolean;
}

export interface CatalogSearchOptions {
	query?: string;
	runtime?: RuntimeKind;
	tags?: string[];
	verified?: boolean;
	sortBy?: "name" | "downloads" | "rating" | "updated";
	sortOrder?: "asc" | "desc";
	limit?: number;
	offset?: number;
}

export interface CatalogSearchResult {
	packages: RuntimePackageManifest[];
	total: number;
	page: number;
	pageSize: number;
}

export interface CatalogStats {
	totalPackages: number;
	totalVersions: number;
	packagesByRuntime: Record<string, number>;
	totalDownloads: number;
	verifiedCount: number;
	averageRating: number;
}

export class RuntimeCatalog {
	private packages: Map<string, Map<string, RuntimePackageManifest>>;

	constructor() {
		this.packages = new Map();
	}

	/**
	 * Publish a runtime package to the catalog.
	 *
	 * @param manifest - The package manifest to publish
	 * @throws Error if required fields are missing or invalid
	 */
	publish(manifest: RuntimePackageManifest): void {
		this.validateManifest(manifest);

		let versions = this.packages.get(manifest.name);
		if (!versions) {
			versions = new Map();
			this.packages.set(manifest.name, versions);
		}

		versions.set(manifest.version, { ...manifest });
	}

	/**
	 * Remove a specific version of a package from the catalog.
	 *
	 * @param name - The package name
	 * @param version - The version to remove
	 * @returns true if the version was removed, false if not found
	 */
	unpublish(name: string, version: string): boolean {
		const versions = this.packages.get(name);
		if (!versions) return false;

		const deleted = versions.delete(version);

		if (versions.size === 0) {
			this.packages.delete(name);
		}

		return deleted;
	}

	/**
	 * Get a package manifest by name and optional version.
	 * Returns the latest version if no version is specified.
	 *
	 * @param name - The package name
	 * @param version - Optional specific version
	 * @returns The manifest if found, undefined otherwise
	 */
	get(name: string, version?: string): RuntimePackageManifest | undefined {
		const versions = this.packages.get(name);
		if (!versions) return undefined;

		if (version) {
			return versions.get(version);
		}

		const latest = this.getLatestVersion(name);
		if (!latest) return undefined;

		return versions.get(latest);
	}

	/**
	 * Get all available versions of a package, sorted by semver descending.
	 *
	 * @param name - The package name
	 * @returns Array of version strings sorted by semver (newest first)
	 */
	getVersions(name: string): string[] {
		const versions = this.packages.get(name);
		if (!versions) return [];

		return Array.from(versions.keys()).sort((a, b) => this.compareSemver(b, a));
	}

	/**
	 * Get the latest version of a package by semver ordering.
	 *
	 * @param name - The package name
	 * @returns The latest version string, or undefined if package not found
	 */
	getLatestVersion(name: string): string | undefined {
		const sorted = this.getVersions(name);
		return sorted.length > 0 ? sorted[0] : undefined;
	}

	/**
	 * Search the catalog with filtering, sorting, and pagination.
	 *
	 * @param options - Search and filter options
	 * @returns Paginated search results
	 */
	search(options: CatalogSearchOptions): CatalogSearchResult {
		const { query, runtime, tags, verified, sortBy = "name", sortOrder = "asc", limit = 20, offset = 0 } = options;

		let results = this.getAllLatestPackages();

		// Filter by query (searches name, description, tags, author)
		if (query) {
			const lowerQuery = query.toLowerCase();
			results = results.filter(
				(pkg) =>
					pkg.name.toLowerCase().includes(lowerQuery) ||
					pkg.description.toLowerCase().includes(lowerQuery) ||
					pkg.author.toLowerCase().includes(lowerQuery) ||
					pkg.tags.some((tag) => tag.toLowerCase().includes(lowerQuery)),
			);
		}

		// Filter by runtime
		if (runtime) {
			results = results.filter((pkg) => pkg.runtime === runtime);
		}

		// Filter by tags (package must have all specified tags)
		if (tags && tags.length > 0) {
			results = results.filter((pkg) =>
				tags.every((tag) => pkg.tags.some((pkgTag) => pkgTag.toLowerCase() === tag.toLowerCase())),
			);
		}

		// Filter by verified status
		if (verified !== undefined) {
			results = results.filter((pkg) => pkg.verified === verified);
		}

		// Sort results
		results.sort((a, b) => {
			let comparison = 0;
			switch (sortBy) {
				case "name":
					comparison = a.name.localeCompare(b.name);
					break;
				case "downloads":
					comparison = a.downloads - b.downloads;
					break;
				case "rating":
					comparison = a.rating - b.rating;
					break;
				case "updated":
					comparison = a.updatedAt - b.updatedAt;
					break;
			}
			return sortOrder === "desc" ? -comparison : comparison;
		});

		const total = results.length;
		const pageSize = limit;
		const page = Math.floor(offset / limit) + 1;
		const paged = results.slice(offset, offset + limit);

		return {
			packages: paged,
			total,
			page,
			pageSize,
		};
	}

	/**
	 * List all latest-version packages for a specific runtime.
	 *
	 * @param runtime - The runtime kind to filter by
	 * @returns Array of matching package manifests
	 */
	listByRuntime(runtime: RuntimeKind): RuntimePackageManifest[] {
		return this.getAllLatestPackages().filter((pkg) => pkg.runtime === runtime);
	}

	/**
	 * Get the most popular packages sorted by download count.
	 *
	 * @param limit - Maximum number of results (default 10)
	 * @returns Array of package manifests sorted by downloads descending
	 */
	getPopular(limit = 10): RuntimePackageManifest[] {
		return this.getAllLatestPackages()
			.sort((a, b) => b.downloads - a.downloads)
			.slice(0, limit);
	}

	/**
	 * Get all verified packages.
	 *
	 * @returns Array of verified package manifests
	 */
	getVerified(): RuntimePackageManifest[] {
		return this.getAllLatestPackages().filter((pkg) => pkg.verified);
	}

	/**
	 * Increment the download counter for a specific package version.
	 *
	 * @param name - The package name
	 * @param version - The package version
	 */
	incrementDownloads(name: string, version: string): void {
		const versions = this.packages.get(name);
		if (!versions) return;

		const manifest = versions.get(version);
		if (manifest) {
			manifest.downloads++;
		}
	}

	/**
	 * Set the rating for a specific package version.
	 *
	 * @param name - The package name
	 * @param version - The package version
	 * @param rating - The rating value (0-5)
	 * @throws Error if rating is out of range
	 */
	setRating(name: string, version: string, rating: number): void {
		if (rating < 0 || rating > 5) {
			throw new Error(`Rating must be between 0 and 5, got ${rating}`);
		}

		const versions = this.packages.get(name);
		if (!versions) return;

		const manifest = versions.get(version);
		if (manifest) {
			manifest.rating = rating;
		}
	}

	/**
	 * Get overall catalog statistics.
	 *
	 * @returns Aggregated catalog statistics
	 */
	getStats(): CatalogStats {
		const allPackages = this.getAllLatestPackages();
		const packagesByRuntime: Record<string, number> = {};
		let totalDownloads = 0;
		let verifiedCount = 0;
		let ratingSum = 0;
		let ratedCount = 0;
		let totalVersions = 0;

		for (const [, versions] of this.packages) {
			totalVersions += versions.size;
		}

		for (const pkg of allPackages) {
			const count = packagesByRuntime[pkg.runtime] || 0;
			packagesByRuntime[pkg.runtime] = count + 1;

			totalDownloads += pkg.downloads;

			if (pkg.verified) {
				verifiedCount++;
			}

			if (pkg.rating > 0) {
				ratingSum += pkg.rating;
				ratedCount++;
			}
		}

		return {
			totalPackages: allPackages.length,
			totalVersions,
			packagesByRuntime,
			totalDownloads,
			verifiedCount,
			averageRating: ratedCount > 0 ? ratingSum / ratedCount : 0,
		};
	}

	/**
	 * Serialize the catalog to a JSON string for persistence.
	 *
	 * @returns JSON string representation of the catalog
	 */
	toJSON(): string {
		const data: Record<string, Record<string, RuntimePackageManifest>> = {};

		for (const [name, versions] of this.packages) {
			data[name] = {};
			for (const [version, manifest] of versions) {
				data[name][version] = manifest;
			}
		}

		return JSON.stringify(data);
	}

	/**
	 * Deserialize a catalog from a JSON string.
	 *
	 * @param json - The JSON string to parse
	 * @returns A new RuntimeCatalog instance populated with the data
	 */
	static fromJSON(json: string): RuntimeCatalog {
		const catalog = new RuntimeCatalog();
		const data = JSON.parse(json) as Record<string, Record<string, RuntimePackageManifest>>;

		for (const name of Object.keys(data)) {
			const versionsMap = new Map<string, RuntimePackageManifest>();
			for (const version of Object.keys(data[name])) {
				versionsMap.set(version, data[name][version]);
			}
			catalog.packages.set(name, versionsMap);
		}

		return catalog;
	}

	/**
	 * Get the latest version manifest for every package in the catalog.
	 */
	private getAllLatestPackages(): RuntimePackageManifest[] {
		const result: RuntimePackageManifest[] = [];

		for (const [name] of this.packages) {
			const latest = this.get(name);
			if (latest) {
				result.push(latest);
			}
		}

		return result;
	}

	/**
	 * Validate that a manifest has all required fields.
	 */
	private validateManifest(manifest: RuntimePackageManifest): void {
		if (!manifest.name || typeof manifest.name !== "string") {
			throw new Error("Package manifest must have a valid 'name'");
		}
		if (!manifest.version || typeof manifest.version !== "string") {
			throw new Error("Package manifest must have a valid 'version'");
		}
		if (!manifest.runtime) {
			throw new Error("Package manifest must have a valid 'runtime'");
		}
		if (!manifest.description || typeof manifest.description !== "string") {
			throw new Error("Package manifest must have a valid 'description'");
		}
		if (!manifest.author || typeof manifest.author !== "string") {
			throw new Error("Package manifest must have a valid 'author'");
		}
		if (!manifest.license || typeof manifest.license !== "string") {
			throw new Error("Package manifest must have a valid 'license'");
		}
		if (!Array.isArray(manifest.tags)) {
			throw new Error("Package manifest must have a 'tags' array");
		}
		if (!Array.isArray(manifest.protocols) || manifest.protocols.length === 0) {
			throw new Error("Package manifest must have at least one 'protocol'");
		}
		if (!Array.isArray(manifest.nodes)) {
			throw new Error("Package manifest must have a 'nodes' array");
		}
	}

	/**
	 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
	 */
	private compareSemver(a: string, b: string): number {
		const partsA = a.split(".").map(Number);
		const partsB = b.split(".").map(Number);

		for (let i = 0; i < 3; i++) {
			const numA = partsA[i] || 0;
			const numB = partsB[i] || 0;
			if (numA !== numB) return numA - numB;
		}

		return 0;
	}
}
