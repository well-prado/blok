/**
 * PromptVersioning Tests
 *
 * Tests the prompt versioning system for reproducibility and tracking
 */

import { describe, expect, it } from "vitest";
import {
	PROMPT_VERSIONS,
	getPromptVersion,
	getAllPromptVersions,
	getVersionStamp,
	computeContentHash,
	registerPromptContent,
} from "./PromptVersioning.js";

describe("PromptVersioning", () => {
	describe("PROMPT_VERSIONS registry", () => {
		it("should have entries for all prompt types", () => {
			expect(PROMPT_VERSIONS["create-fn-node"]).toBeDefined();
			expect(PROMPT_VERSIONS["create-node"]).toBeDefined();
			expect(PROMPT_VERSIONS["create-workflow"]).toBeDefined();
			expect(PROMPT_VERSIONS["create-trigger"]).toBeDefined();
		});

		it("should have valid version strings for all entries", () => {
			for (const [id, version] of Object.entries(PROMPT_VERSIONS)) {
				expect(version.version).toMatch(/^\d+\.\d+\.\d+$/);
				expect(version.id).toBe(id);
				expect(version.changelog).toBeTruthy();
				expect(version.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			}
		});

		it("should have function-first node at v2.0.0 with defineNode pattern", () => {
			const fnNode = PROMPT_VERSIONS["create-fn-node"];
			expect(fnNode.version).toBe("2.0.0");
			expect(fnNode.changelog).toContain("defineNode");
		});

		it("should have workflow prompt at v2.0.0 with trigger types", () => {
			const workflow = PROMPT_VERSIONS["create-workflow"];
			expect(workflow.version).toBe("2.0.0");
			expect(workflow.changelog).toContain("trigger");
		});

		it("should have trigger prompt at v2.0.0 with TriggerBase", () => {
			const trigger = PROMPT_VERSIONS["create-trigger"];
			expect(trigger.version).toBe("2.0.0");
			expect(trigger.changelog).toContain("TriggerBase");
		});
	});

	describe("getPromptVersion", () => {
		it("should return version for known prompt ID", () => {
			const version = getPromptVersion("create-fn-node");
			expect(version).toBeDefined();
			expect(version!.id).toBe("create-fn-node");
		});

		it("should return undefined for unknown prompt ID", () => {
			const version = getPromptVersion("nonexistent-prompt");
			expect(version).toBeUndefined();
		});
	});

	describe("getAllPromptVersions", () => {
		it("should return all registered prompt versions", () => {
			const versions = getAllPromptVersions();
			expect(versions.length).toBeGreaterThanOrEqual(4);
		});

		it("should include all known prompt IDs", () => {
			const versions = getAllPromptVersions();
			const ids = versions.map((v) => v.id);
			expect(ids).toContain("create-fn-node");
			expect(ids).toContain("create-node");
			expect(ids).toContain("create-workflow");
			expect(ids).toContain("create-trigger");
		});
	});

	describe("getVersionStamp", () => {
		it("should return formatted version stamp for known prompt", () => {
			const stamp = getVersionStamp("create-fn-node");
			expect(stamp).toBe("create-fn-node@2.0.0");
		});

		it("should return unknown stamp for unregistered prompt", () => {
			const stamp = getVersionStamp("unknown-prompt");
			expect(stamp).toBe("unknown-prompt@unknown");
		});

		it("should return stamps in id@version format", () => {
			for (const [id, version] of Object.entries(PROMPT_VERSIONS)) {
				const stamp = getVersionStamp(id);
				expect(stamp).toBe(`${id}@${version.version}`);
			}
		});
	});

	describe("computeContentHash", () => {
		it("should return a non-empty string", () => {
			const hash = computeContentHash("test content");
			expect(hash).toBeTruthy();
			expect(typeof hash).toBe("string");
		});

		it("should return consistent hash for same content", () => {
			const hash1 = computeContentHash("hello world");
			const hash2 = computeContentHash("hello world");
			expect(hash1).toBe(hash2);
		});

		it("should return different hashes for different content", () => {
			const hash1 = computeContentHash("content A");
			const hash2 = computeContentHash("content B");
			expect(hash1).not.toBe(hash2);
		});

		it("should handle empty string", () => {
			const hash = computeContentHash("");
			expect(hash).toBe("0");
		});

		it("should handle long content", () => {
			const longContent = "a".repeat(10000);
			const hash = computeContentHash(longContent);
			expect(hash).toBeTruthy();
		});
	});

	describe("registerPromptContent", () => {
		it("should compute and store content hash for known prompt", () => {
			registerPromptContent("create-fn-node", "test prompt content");
			const version = getPromptVersion("create-fn-node");
			expect(version!.contentHash).toBeTruthy();
			expect(version!.contentHash).toBe(computeContentHash("test prompt content"));
		});

		it("should not throw for unknown prompt ID", () => {
			expect(() => registerPromptContent("nonexistent", "content")).not.toThrow();
		});

		it("should update hash when content changes", () => {
			registerPromptContent("create-node", "content v1");
			const hash1 = getPromptVersion("create-node")!.contentHash;

			registerPromptContent("create-node", "content v2");
			const hash2 = getPromptVersion("create-node")!.contentHash;

			expect(hash1).not.toBe(hash2);
		});
	});
});
