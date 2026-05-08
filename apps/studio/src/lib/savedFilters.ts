/**
 * Tier 2 follow-up · Saved Filters for the runs list.
 *
 * Persists named filter combinations (status + tags + metadata) to
 * `localStorage` under the key `blok.studio.savedFilters`. Used by
 * `RunFilters.tsx` — operators select a saved filter from a dropdown
 * to apply it; "Save current..." prompts for a name and persists.
 *
 * No server side; entirely client-state. Each browser maintains its
 * own list. If we add server-side persistence later, this module
 * stays as the local read/write API and adds an optional sync layer.
 */

const STORAGE_KEY = "blok.studio.savedFilters";

export interface SavedFilter {
	name: string;
	status: string;
	tagsInput: string;
	metadataInput: string;
}

function isStringField(v: unknown): v is string {
	return typeof v === "string";
}

function isSavedFilter(v: unknown): v is SavedFilter {
	if (!v || typeof v !== "object") return false;
	const f = v as Record<string, unknown>;
	return (
		isStringField(f.name) && isStringField(f.status) && isStringField(f.tagsInput) && isStringField(f.metadataInput)
	);
}

export function loadSavedFilters(): SavedFilter[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSavedFilter);
	} catch {
		return [];
	}
}

function persist(filters: SavedFilter[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
	} catch {
		// localStorage may be unavailable (private mode, quota); silent best-effort.
	}
}

export function saveFilter(filter: SavedFilter): SavedFilter[] {
	const existing = loadSavedFilters();
	// Replace by name (overwrite semantics) so "Save current as 'foo'" always
	// produces a single entry per name, even on re-save.
	const next = existing.filter((f) => f.name !== filter.name).concat(filter);
	persist(next);
	return next;
}

export function deleteSavedFilter(name: string): SavedFilter[] {
	const existing = loadSavedFilters();
	const next = existing.filter((f) => f.name !== name);
	persist(next);
	return next;
}

export function clearSavedFilters(): void {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// silent
	}
}
