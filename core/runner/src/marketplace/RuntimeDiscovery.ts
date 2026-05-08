/**
 * RuntimeDiscovery - Package Discovery and Resolution Service
 *
 * Helps find, resolve, and recommend runtime packages from the catalog.
 * Provides compatibility checking, semver range resolution, and
 * intelligent package recommendations for the Blok marketplace.
 */

import type { RuntimeRegistry } from "../RuntimeRegistry";
import type { RuntimeKind } from "../adapters/RuntimeAdapter";
import type { RuntimePackageManifest } from "./RuntimeCatalog";
import type { RuntimeCatalog } from "./RuntimeCatalog";

export interface CompatibilityInfo {
	compatible: boolean;
	blokVersionMatch: boolean;
	runtimeAvailable: boolean;
	protocolSupported: boolean;
	warnings: string[];
}

export interface DiscoveryResult {
	package: RuntimePackageManifest;
	compatibility: CompatibilityInfo;
	alternatives: RuntimePackageManifest[];
}

export interface ResolveOptions {
	name: string;
	version?: string;
	runtime?: RuntimeKind;
	preferVerified?: boolean;
}

export class RuntimeDiscovery {
	private catalog: RuntimeCatalog;
	private registry: RuntimeRegistry;

	constructor(catalog: RuntimeCatalog, registry: RuntimeRegistry) {
		this.catalog = catalog;
		this.registry = registry;
	}

	/**
	 * Discover all packages available for a specific runtime.
	 *
	 * @param runtime - The runtime kind to discover packages for
	 * @returns Array of matching package manifests
	 */
	discover(runtime: RuntimeKind): RuntimePackageManifest[] {
		return this.catalog.listByRuntime(runtime);
	}

	/**
	 * Resolve a package by name with full compatibility checking.
	 *
	 * @param options - Resolution options including name, version, runtime preference
	 * @returns Discovery result with compatibility info and alternatives, or undefined
	 */
	resolve(options: ResolveOptions): DiscoveryResult | undefined {
		const { name, version, runtime, preferVerified } = options;

		let resolvedVersion: string | undefined;

		if (version) {
			// Check if this is a semver range or exact version
			if (version.startsWith("^") || version.startsWith("~") || version.startsWith(">=")) {
				resolvedVersion = this.resolveVersion(name, version);
			} else {
				resolvedVersion = version;
			}
		}

		const manifest = this.catalog.get(name, resolvedVersion);
		if (!manifest) return undefined;

		// If runtime is specified, verify it matches
		if (runtime && manifest.runtime !== runtime) {
			return undefined;
		}

		const compatibility = this.checkCompatibility(manifest);
		let alternatives = this.findAlternatives(name, manifest.runtime);

		// If preferVerified, sort alternatives with verified first
		if (preferVerified) {
			alternatives = alternatives.sort((a, b) => {
				if (a.verified && !b.verified) return -1;
				if (!a.verified && b.verified) return 1;
				return 0;
			});
		}

		return {
			package: manifest,
			compatibility,
			alternatives,
		};
	}

	/**
	 * Find alternative packages similar to a given package.
	 * Searches by shared tags and runtime kind.
	 *
	 * @param name - The package name to find alternatives for
	 * @param runtime - Optional runtime kind to filter alternatives
	 * @returns Array of alternative package manifests
	 */
	findAlternatives(name: string, runtime?: RuntimeKind): RuntimePackageManifest[] {
		const original = this.catalog.get(name);
		const searchResult = this.catalog.search({
			runtime,
			limit: 100,
		});

		// Exclude the original package and score by tag overlap
		const candidates = searchResult.packages.filter((pkg) => pkg.name !== name);

		if (!original) return candidates;

		// Score by tag similarity
		const scored = candidates.map((pkg) => {
			const sharedTags = pkg.tags.filter((tag) =>
				original.tags.some((oTag) => oTag.toLowerCase() === tag.toLowerCase()),
			);
			return { pkg, score: sharedTags.length };
		});

		scored.sort((a, b) => b.score - a.score);

		return scored.map((s) => s.pkg);
	}

	/**
	 * Check if a package is compatible with the current environment.
	 *
	 * @param manifest - The package manifest to check
	 * @returns Compatibility information with warnings
	 */
	checkCompatibility(manifest: RuntimePackageManifest): CompatibilityInfo {
		const warnings: string[] = [];
		let runtimeAvailable = false;
		const blokVersionMatch = true;
		let protocolSupported = true;

		// Check if the runtime adapter is registered
		try {
			runtimeAvailable = this.registry.has(manifest.runtime);
		} catch {
			runtimeAvailable = false;
		}

		if (!runtimeAvailable) {
			warnings.push(
				`Runtime '${manifest.runtime}' is not currently registered. Install the adapter before using this package.`,
			);
		}

		// Check minimum Blok version compatibility
		if (manifest.minBlokVersion) {
			// In a real implementation, this would compare against the actual Blok version.
			// For now, we assume compatibility and note the requirement.
			warnings.push(
				`Package requires minimum Blok version ${manifest.minBlokVersion}. Verify your Blok installation is compatible.`,
			);
		}

		// Check protocol support
		if (manifest.protocols.length === 0) {
			protocolSupported = false;
			warnings.push("Package does not declare any supported protocols.");
		}

		const compatible = runtimeAvailable && blokVersionMatch && protocolSupported;

		return {
			compatible,
			blokVersionMatch,
			runtimeAvailable,
			protocolSupported,
			warnings,
		};
	}

	/**
	 * Recommend packages for a runtime, optionally filtered by tags.
	 * Results are sorted by a composite score of rating and downloads.
	 *
	 * @param runtime - The runtime kind to recommend packages for
	 * @param tags - Optional tags to filter recommendations
	 * @returns Array of recommended package manifests
	 */
	recommend(runtime: RuntimeKind, tags?: string[]): RuntimePackageManifest[] {
		let candidates = this.catalog.listByRuntime(runtime);

		// Filter by tags if provided
		if (tags && tags.length > 0) {
			candidates = candidates.filter((pkg) =>
				tags.some((tag) => pkg.tags.some((pkgTag) => pkgTag.toLowerCase() === tag.toLowerCase())),
			);
		}

		// Sort by composite score: rating * log(downloads + 1)
		candidates.sort((a, b) => {
			const scoreA = a.rating * Math.log(a.downloads + 1);
			const scoreB = b.rating * Math.log(b.downloads + 1);
			return scoreB - scoreA;
		});

		return candidates;
	}

	/**
	 * Resolve a semver range to a specific version available in the catalog.
	 * Supports exact versions, >= (minimum), ^ (caret), and ~ (tilde) ranges.
	 *
	 * @param name - The package name
	 * @param range - The semver range string (e.g., ">=1.0.0", "^1.2.0", "~2.0.0", "1.5.3")
	 * @returns The resolved version string, or undefined if no match found
	 */
	resolveVersion(name: string, range: string): string | undefined {
		const versions = this.catalog.getVersions(name);
		if (versions.length === 0) return undefined;

		// Exact version match
		if (!range.startsWith("^") && !range.startsWith("~") && !range.startsWith(">=")) {
			return versions.includes(range) ? range : undefined;
		}

		let prefix: string;
		let baseVersion: string;

		if (range.startsWith(">=")) {
			prefix = ">=";
			baseVersion = range.slice(2);
		} else {
			prefix = range[0];
			baseVersion = range.slice(1);
		}

		const baseParts = baseVersion.split(".").map(Number);

		if (baseParts.length < 3) {
			// Pad with zeros
			while (baseParts.length < 3) {
				baseParts.push(0);
			}
		}

		const [baseMajor, baseMinor, basePatch] = baseParts;

		const matching = versions.filter((v) => {
			const parts = v.split(".").map(Number);
			const [major, minor, patch] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];

			if (prefix === ">=") {
				// Minimum version: any version >= base
				return this.semverGte(major, minor, patch, baseMajor, baseMinor, basePatch);
			}

			if (prefix === "^") {
				// Caret: allows changes that do not modify the left-most non-zero digit
				// ^1.2.3 := >=1.2.3 <2.0.0
				// ^0.2.3 := >=0.2.3 <0.3.0
				// ^0.0.3 := >=0.0.3 <0.0.4
				if (baseMajor !== 0) {
					return major === baseMajor && this.semverGte(major, minor, patch, baseMajor, baseMinor, basePatch);
				}
				if (baseMinor !== 0) {
					return major === 0 && minor === baseMinor && patch >= basePatch;
				}
				return major === 0 && minor === 0 && patch === basePatch;
			}

			if (prefix === "~") {
				// Tilde: allows patch-level changes
				// ~1.2.3 := >=1.2.3 <1.3.0
				return major === baseMajor && minor === baseMinor && patch >= basePatch;
			}

			return false;
		});

		// Return the highest matching version (versions are already sorted desc)
		return matching.length > 0 ? matching[0] : undefined;
	}

	/**
	 * Check if version (major, minor, patch) is >= base version.
	 */
	private semverGte(
		major: number,
		minor: number,
		patch: number,
		baseMajor: number,
		baseMinor: number,
		basePatch: number,
	): boolean {
		if (major !== baseMajor) return major > baseMajor;
		if (minor !== baseMinor) return minor > baseMinor;
		return patch >= basePatch;
	}
}
