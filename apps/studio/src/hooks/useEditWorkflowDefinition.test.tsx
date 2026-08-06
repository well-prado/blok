import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * feat/studio-deploy-ux — hook-level coverage for the draft seam. Mocks the
 * three `@/lib/api` functions the hook calls (GET, dry-run PUT, real PUT)
 * so every assertion is about the hook's own bookkeeping: one GET across
 * many edits, zero PUTs until an explicit deploy, a mutator throw leaving
 * the draft untouched, and the debounced dry-run guard's valid/invalid/stale
 * states.
 */
const mocks = vi.hoisted(() => ({
	fetchWorkflowDefinition: vi.fn(),
	saveWorkflowDefinition: vi.fn(),
	dryRunWorkflowDefinition: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		fetchWorkflowDefinition: mocks.fetchWorkflowDefinition,
		saveWorkflowDefinition: mocks.saveWorkflowDefinition,
		dryRunWorkflowDefinition: mocks.dryRunWorkflowDefinition,
	};
});

import { ApiError } from "@/lib/api";
import { useEditWorkflowDefinition } from "./useWorkflows";

function wrapper({ children }: { children: React.ReactNode }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useEditWorkflowDefinition", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Background validation defaults to "valid" unless a test overrides
		// it — keeps unrelated tests from racing a rejected dry run.
		mocks.dryRunWorkflowDefinition.mockResolvedValue({ valid: true, etag: "etag-1" });
	});

	it("mutate twice: one GET, zero PUTs, the draft holds both edits", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [{ id: "a" }] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [...(def.steps as unknown[]), { id: "b" }] }));
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(true));

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [...(def.steps as unknown[]), { id: "c" }] }));
		});
		await waitFor(() =>
			expect((result.current.draft?.steps as Array<{ id: string }>).map((s) => s.id)).toEqual(["a", "b", "c"]),
		);

		expect(mocks.fetchWorkflowDefinition).toHaveBeenCalledTimes(1);
		expect(mocks.saveWorkflowDefinition).not.toHaveBeenCalled();
	});

	it("deploy writes exactly one PUT without dryRun, then clears the draft", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		mocks.saveWorkflowDefinition.mockResolvedValue({
			definition: { steps: [{ id: "a" }] },
			etag: "etag-2",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(true));

		act(() => {
			result.current.deploy();
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(false));

		expect(mocks.saveWorkflowDefinition).toHaveBeenCalledTimes(1);
		expect(mocks.saveWorkflowDefinition).toHaveBeenCalledWith("wf", { steps: [{ id: "a" }] }, "etag-1");
	});

	it("discard drops the draft and goes back to the deployed definition", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(true));

		act(() => result.current.discard());

		await waitFor(() => expect(result.current.hasDraft).toBe(false));
		expect(result.current.draft).toBeNull();
	});

	it("a mutator throw on the first edit surfaces the error and creates no draft", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate(() => {
				throw new Error('duplicate id "a"');
			});
		});

		await waitFor(() => expect(result.current.error?.message).toBe('duplicate id "a"'));
		expect(result.current.hasDraft).toBe(false);
		expect(result.current.draft).toBeNull();
	});

	it("a mutator throw on a later edit leaves the existing draft untouched", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [{ id: "a" }] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [...(def.steps as unknown[]), { id: "b" }] }));
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(true));
		const draftBefore = result.current.draft;

		act(() => {
			result.current.mutate(() => {
				throw new Error("boom");
			});
		});
		await waitFor(() => expect(result.current.error?.message).toBe("boom"));

		// Same reference — the failed transform never reached setDraft.
		expect(result.current.draft).toBe(draftBefore);
		expect(mocks.fetchWorkflowDefinition).toHaveBeenCalledTimes(1);
	});

	it("debounces a dry run after a draft change and lands on valid", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});

		await waitFor(() => expect(result.current.validation.status).toBe("pending"));
		await waitFor(() => expect(result.current.validation.status).toBe("valid"), { timeout: 2000 });
		expect(mocks.dryRunWorkflowDefinition).toHaveBeenCalledWith("wf", { steps: [{ id: "a" }] }, "etag-1");
	});

	it("an invalid dry-run response disables deploy with the server's error message", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		mocks.dryRunWorkflowDefinition.mockRejectedValue(new ApiError(400, 'duplicate id "a"'));
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});

		await waitFor(() => expect(result.current.validation.status).toBe("invalid"), { timeout: 2000 });
		expect(result.current.validation).toEqual({ status: "invalid", message: 'duplicate id "a"' });
	});

	it("a stale_etag (409) dry-run response surfaces a distinct guard state, not invalid", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		mocks.dryRunWorkflowDefinition.mockRejectedValue(
			new ApiError(409, "Workflow definition changed since it was loaded."),
		);
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});

		await waitFor(() => expect(result.current.validation.status).toBe("stale"), { timeout: 2000 });
	});

	it("a stale_etag (409) on deploy itself does not clear the draft", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		mocks.saveWorkflowDefinition.mockRejectedValue(
			new ApiError(409, "Workflow definition changed since it was loaded."),
		);
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(true));

		act(() => {
			result.current.deploy();
		});

		await waitFor(() => expect(result.current.validation.status).toBe("stale"));
		// The draft must survive — deploy failing on a stale etag is NOT
		// license to silently drop the operator's in-progress edits.
		expect(result.current.hasDraft).toBe(true);
	});
});
