import {
	ApiError,
	DryRunUnsupportedError,
	deleteWorkflowSample,
	dryRunWorkflowDefinition,
	fetchNodeCatalog,
	fetchWorkflowDefinition,
	fetchWorkflowDetail,
	fetchWorkflowStudio,
	fetchWorkflows,
	saveWorkflowDefinition,
	saveWorkflowStudio,
} from "@/lib/api";
import type { WorkflowStudioConfig } from "@/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

export function useWorkflows() {
	return useQuery({
		queryKey: ["workflows"],
		queryFn: fetchWorkflows,
		refetchInterval: 5000,
	});
}

export function useWorkflowDetail(name: string) {
	return useQuery({
		queryKey: ["workflow", name],
		queryFn: () => fetchWorkflowDetail(name),
		enabled: !!name,
	});
}

export function useWorkflowStudio(name: string) {
	return useQuery({
		queryKey: ["workflow-studio", name],
		queryFn: () => fetchWorkflowStudio(name),
		enabled: !!name,
	});
}

export function useSaveWorkflowStudio(name: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ config, baseEtag }: { config: WorkflowStudioConfig; baseEtag: string | null }) =>
			saveWorkflowStudio(name, config, baseEtag),
		onSuccess: (saved) => queryClient.setQueryData(["workflow-studio", name], saved),
	});
}

/**
 * Phase 5.2 — the node catalog for the palette. The catalog only changes on
 * deploys, so cache it for the session.
 */
export function useNodeCatalog(enabled: boolean) {
	return useQuery({
		queryKey: ["node-catalog"],
		queryFn: fetchNodeCatalog,
		enabled,
		staleTime: 5 * 60 * 1000,
	});
}

/**
 * feat/studio-deploy-ux guard state for the background dry-run validation
 * that gates the Deploy button. `message` only carries the server's error
 * text for the two failure shapes the UI branches on.
 */
export type DefinitionValidationState =
	| { status: "idle" }
	| { status: "pending" }
	| { status: "valid" }
	| { status: "invalid"; message: string }
	| { status: "stale"; message: string };

/**
 * Phase 5.4 → feat/studio-deploy-ux — every canvas edit flows through this
 * one seam. Edits no longer write straight to disk (ION/ATOMIC/BuildShip
 * pattern): the first `mutate()` GETs the raw on-disk definition + etag and
 * seeds an in-memory DRAFT; every later `mutate()` applies its transform to
 * the CURRENT draft — one GET total, zero PUTs. The draft is the thing the
 * canvas renders (`draft ?? definition` at the call site) and the only
 * thing `deploy()` writes.
 *
 * `deploy()` is the sole write path, and it's guarded: a debounced (~500ms)
 * background dry run (`PUT .../definition` with `dryRun: true`) validates
 * every draft change against the runner's normalizer, so a broken workflow
 * (duplicate id, malformed branch, etc.) can never be deployed — Deploy
 * stays disabled until `validation.status === "valid"`. A 409 (someone else
 * changed the file on disk) surfaces as `validation.status === "stale"`
 * instead of auto-overwriting.
 *
 * Call-signature is UNCHANGED from the old GET-transform-PUT-per-edit
 * version — every caller (insertNode, removeStep, saveInputs, saveBranch,
 * saveTrigger, submitRename, toggleSkip/toggleStop) keeps calling
 * `mutate(transform, { onSuccess })` exactly as before.
 */
export function useEditWorkflowDefinition(name: string) {
	const queryClient = useQueryClient();
	const draftRef = useRef<Record<string, unknown> | null>(null);
	const baseEtagRef = useRef<string | null>(null);
	const [draft, setDraftState] = useState<Record<string, unknown> | null>(null);
	const [baseEtag, setBaseEtagState] = useState<string | null>(null);
	const [validation, setValidation] = useState<DefinitionValidationState>({ status: "idle" });
	const [justDeployed, setJustDeployed] = useState(false);
	const dryRunUnsupportedRef = useRef(false);

	const setDraft = useCallback((next: Record<string, unknown> | null, etag: string | null) => {
		draftRef.current = next;
		baseEtagRef.current = etag;
		setDraftState(next);
		setBaseEtagState(etag);
	}, []);

	const editMutation = useMutation({
		mutationFn: async (transform: (definition: Record<string, unknown>) => Record<string, unknown>) => {
			let base = draftRef.current;
			let etag = baseEtagRef.current;
			if (base === null || etag === null) {
				const current = await fetchWorkflowDefinition(name);
				base = current.definition;
				etag = current.etag;
			}
			// Thrown here (e.g. irEditOps duplicate-id) rejects the mutation
			// before `onSuccess` runs — the draft refs are untouched, so a
			// failed edit never materializes a draft (or corrupts an existing
			// one). `.error` on the returned mutation surfaces the message.
			return { next: transform(base), etag };
		},
		onSuccess: ({ next, etag }) => setDraft(next, etag),
	});

	const deployMutation = useMutation({
		mutationFn: async () => {
			if (draftRef.current === null || baseEtagRef.current === null) {
				throw new Error("No draft to deploy");
			}
			return saveWorkflowDefinition(name, draftRef.current, baseEtagRef.current);
		},
		onSuccess: () => {
			setDraft(null, null);
			setValidation({ status: "idle" });
			queryClient.invalidateQueries({ queryKey: ["workflow", name] });
			setJustDeployed(true);
		},
		onError: (error) => {
			// A real (non-dry-run) 409 means someone else changed the file
			// between the last dry run and this deploy — same "stale" guard
			// state as the background validator, never auto-overwrite.
			if (error instanceof ApiError && error.status === 409) {
				setValidation({ status: "stale", message: error.message });
			}
		},
	});

	const discard = useCallback(() => {
		setDraft(null, null);
		setValidation({ status: "idle" });
		editMutation.reset();
		// Covers the stale-etag "reload" affordance too: dropping the draft
		// and refetching in one action means Discard IS Reload.
		queryClient.invalidateQueries({ queryKey: ["workflow", name] });
	}, [setDraft, queryClient, name, editMutation.reset]);

	// Background validation guard: debounce ~500ms after every draft change,
	// then dry-run the definition against the runner's normalizer. `requested`
	// pins which draft this response belongs to — a slow response for a
	// since-superseded draft is dropped so it can never clobber a newer
	// pending/valid/invalid state (the debounce timer alone doesn't cover an
	// in-flight fetch that outlives the next edit).
	useEffect(() => {
		if (draft === null || baseEtag === null) {
			setValidation({ status: "idle" });
			return;
		}
		// Version-skew latch: an old runner treats dryRun as a REAL save (see
		// DryRunUnsupportedError). One detection pins the invalid state and
		// stops ALL further background validation — re-firing per edit would
		// keep silently deploying drafts to disk.
		if (dryRunUnsupportedRef.current) return;
		setValidation({ status: "pending" });
		const requested = draft;
		const timer = setTimeout(() => {
			dryRunWorkflowDefinition(name, requested, baseEtag)
				.then(() => {
					if (draftRef.current !== requested) return;
					setValidation({ status: "valid" });
				})
				.catch((error: unknown) => {
					if (error instanceof DryRunUnsupportedError) {
						dryRunUnsupportedRef.current = true;
						setValidation({ status: "invalid", message: error.message });
						return;
					}
					if (draftRef.current !== requested) return;
					if (error instanceof ApiError && error.status === 409) {
						setValidation({ status: "stale", message: error.message });
					} else {
						setValidation({
							status: "invalid",
							message: error instanceof Error ? error.message : "Validation failed",
						});
					}
				});
		}, 500);
		return () => clearTimeout(timer);
	}, [draft, baseEtag, name]);

	useEffect(() => {
		if (!justDeployed) return;
		const timer = setTimeout(() => setJustDeployed(false), 1500);
		return () => clearTimeout(timer);
	}, [justDeployed]);

	return {
		mutate: editMutation.mutate,
		isPending: editMutation.isPending,
		error: editMutation.error,
		reset: editMutation.reset,
		/** The in-memory draft (raw definition), or `null` when there isn't one. Render `draft ?? definition`. */
		draft,
		hasDraft: draft !== null,
		validation,
		/** Drop the draft, back to the deployed definition. Also refetches (doubles as the stale-etag "reload" action). */
		discard,
		deploy: deployMutation.mutate,
		deploying: deployMutation.isPending,
		deployError: deployMutation.error,
		/** True for ~1.5s right after a successful deploy — drives a brief success state. */
		justDeployed,
	};
}

/**
 * #103 follow-up — delete the recorded sample so the next successful
 * run re-records. On success invalidates the workflow detail query so
 * the curl preview + `source` label refreshes to whatever resolves
 * next (author > inferred > empty, since the recorded row is gone).
 */
export function useDeleteWorkflowSample(name: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => deleteWorkflowSample(name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workflow", name] });
		},
	});
}
