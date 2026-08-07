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

/**
 * Phase 5.1 — undo/redo. The hook already tracks one draft in a ref+state
 * pair per edit; these tests cover the two stacks layered on top: undoing
 * the very first edit must reach `hasDraft === false` (the deployed
 * baseline), not a draft that happens to equal it, and a fresh edit after
 * an undo must discard whatever redo branch existed.
 */
describe("useEditWorkflowDefinition undo/redo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.dryRunWorkflowDefinition.mockResolvedValue({ valid: true, etag: "etag-1" });
	});

	it("undo steps back through prior edits and reaches the deployed baseline (no draft) past the first edit", async () => {
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
		const afterFirstEdit = result.current.draft;

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [...(def.steps as unknown[]), { id: "b" }] }));
		});
		await waitFor(() =>
			expect((result.current.draft?.steps as Array<{ id: string }>).map((s) => s.id)).toEqual(["a", "b"]),
		);

		act(() => result.current.undo());
		await waitFor(() => expect(result.current.draft).toBe(afterFirstEdit));
		expect(result.current.canUndo).toBe(true);
		expect(result.current.canRedo).toBe(true);

		act(() => result.current.undo());
		await waitFor(() => expect(result.current.hasDraft).toBe(false));
		expect(result.current.draft).toBeNull();
		expect(result.current.canUndo).toBe(false);
		expect(result.current.canRedo).toBe(true);
	});

	it("redo restores an undone edit; a new edit after undo clears the redo stack", async () => {
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
		const latest = result.current.draft;

		act(() => result.current.undo());
		await waitFor(() => expect(result.current.hasDraft).toBe(false));

		act(() => result.current.redo());
		await waitFor(() => expect(result.current.draft).toBe(latest));
		expect(result.current.canRedo).toBe(false);
		expect(result.current.canUndo).toBe(true);

		act(() => result.current.undo());
		await waitFor(() => expect(result.current.hasDraft).toBe(false));
		expect(result.current.canRedo).toBe(true);

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "z" }] }));
		});
		await waitFor(() => expect((result.current.draft?.steps as Array<{ id: string }>).map((s) => s.id)).toEqual(["z"]));
		expect(result.current.canRedo).toBe(false);
	});

	it("canUndo/canRedo start false and flip at the stack boundaries", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		expect(result.current.canUndo).toBe(false);
		expect(result.current.canRedo).toBe(false);

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});
		await waitFor(() => expect(result.current.canUndo).toBe(true));
		expect(result.current.canRedo).toBe(false);

		act(() => result.current.undo());
		await waitFor(() => expect(result.current.canRedo).toBe(true));
		expect(result.current.canUndo).toBe(false);

		// Nothing left to undo — a second undo is a no-op.
		act(() => result.current.undo());
		expect(result.current.canUndo).toBe(false);
		expect(result.current.hasDraft).toBe(false);
	});

	it("caps history at 50 snapshots: undo works exactly to the cap, then stops", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [], n: 0 },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		for (let i = 1; i <= 55; i++) {
			const n = i;
			act(() => {
				result.current.mutate((def) => ({ ...def, n }));
			});
			await waitFor(() => expect(result.current.draft?.n).toBe(n));
		}

		for (let i = 0; i < 50; i++) {
			act(() => result.current.undo());
		}
		await waitFor(() => expect(result.current.canUndo).toBe(false));
		// The oldest 5 pre-edit snapshots (baseline through edit #4) were
		// dropped once history exceeded the 50-entry cap, so 50 undos from
		// n=55 bottoms out at n=5, not back at the deployed baseline.
		expect(result.current.draft?.n).toBe(5);

		// One more undo is a no-op past the cap.
		act(() => result.current.undo());
		expect(result.current.draft?.n).toBe(5);
		expect(result.current.canUndo).toBe(false);
	});

	it("discard() and a successful deploy() both clear the undo history", async () => {
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
		await waitFor(() => expect(result.current.canUndo).toBe(true));

		act(() => result.current.discard());
		await waitFor(() => expect(result.current.hasDraft).toBe(false));
		expect(result.current.canUndo).toBe(false);

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});
		await waitFor(() => expect(result.current.canUndo).toBe(true));

		act(() => {
			result.current.deploy();
		});
		await waitFor(() => expect(result.current.hasDraft).toBe(false));
		expect(result.current.canUndo).toBe(false);
	});

	it("undo re-triggers the debounced dry-run validation for the restored draft", async () => {
		mocks.fetchWorkflowDefinition.mockResolvedValue({
			definition: { steps: [] },
			etag: "etag-1",
			sourcePath: "/x.json",
		});
		const { result } = renderHook(() => useEditWorkflowDefinition("wf"), { wrapper });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [{ id: "a" }] }));
		});
		await waitFor(() => expect(result.current.validation.status).toBe("valid"), { timeout: 2000 });

		act(() => {
			result.current.mutate((def) => ({ ...def, steps: [...(def.steps as unknown[]), { id: "b" }] }));
		});
		await waitFor(() => expect(result.current.validation.status).toBe("valid"), { timeout: 2000 });

		mocks.dryRunWorkflowDefinition.mockClear();

		act(() => result.current.undo());
		await waitFor(() => expect(result.current.validation.status).toBe("pending"));
		await waitFor(() => expect(result.current.validation.status).toBe("valid"), { timeout: 2000 });
		expect(mocks.dryRunWorkflowDefinition).toHaveBeenCalledTimes(1);
		expect(mocks.dryRunWorkflowDefinition).toHaveBeenCalledWith("wf", { steps: [{ id: "a" }] }, "etag-1");
	});
});
