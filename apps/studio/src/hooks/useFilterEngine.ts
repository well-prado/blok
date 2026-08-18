// @ts-nocheck
import { EMPTY_FILTER, type FilterState, countActiveFilters } from "@/lib/filterTypes";
import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * Helper to safely parse JSON strings or fallback to null/default.
 */
function safeParseJSON(val: unknown, fallback: unknown = null) {
	if (typeof val === "string") {
		try {
			return JSON.parse(val);
		} catch {
			return fallback;
		}
	}
	if (val && typeof val === "object") {
		return val;
	}
	return fallback;
}

/**
 * Helper to parse a comma-separated string into a string array.
 */
function parseStringArray(val: unknown): string[] {
	if (Array.isArray(val)) {
		return val.map(String).filter(Boolean);
	}
	if (typeof val === "string" && val.trim().length > 0) {
		return val.split(",").filter(Boolean);
	}
	return [];
}

/**
 * Central hook for syncing filter state with URL search params.
 */
export function useFilterEngine() {
	// Read current search params from the router (loose typing to allow any filter keys)
	const searchParams = useSearch({ strict: false }) as Record<string, unknown>;
	const navigate = useNavigate();

	// Construct the current FilterState from URL parameters
	const filters: FilterState = {
		status: parseStringArray(searchParams.status),
		workflow: parseStringArray(searchParams.workflow),
		triggerType: parseStringArray(searchParams.triggerType),
		runtimeKind: parseStringArray(searchParams.runtimeKind),
		node: parseStringArray(searchParams.node),
		tags: parseStringArray(searchParams.tags),
		metadata: safeParseJSON(searchParams.metadata, {}),
		timePeriod: safeParseJSON(searchParams.timePeriod, null),
		durationBucket: typeof searchParams.durationBucket === "string" ? searchParams.durationBucket : null,
	};

	// How many filters are currently active?
	const activeCount = countActiveFilters(filters);

	/**
	 * Convert current state to API params for `fetchRuns`.
	 */
	const toApiParams = () => {
		const params: Record<string, unknown> = {};
		if (filters.status.length > 0) {
			params.status = filters.status.join(",");
		}
		if (filters.workflow.length > 0) {
			params.workflow = filters.workflow.join(",");
		}
		if (filters.tags.length > 0) {
			params.tags = filters.tags;
		}
		if (Object.keys(filters.metadata).length > 0) {
			params.metadata = filters.metadata;
		}
		// If api.ts fetchRuns is updated to accept these later, we can pass them along here.
		if (filters.triggerType.length > 0) {
			params.triggerType = filters.triggerType.join(",");
		}
		if (filters.runtimeKind.length > 0) {
			params.runtimeKind = filters.runtimeKind.join(",");
		}
		if (filters.node.length > 0) {
			params.node = filters.node.join(",");
		}
		if (filters.timePeriod) {
			params.timePeriod = JSON.stringify(filters.timePeriod);
		}
		if (filters.durationBucket) {
			params.durationBucket = filters.durationBucket;
		}
		return params;
	};

	/**
	 * Serialize a single field value for the URL.
	 */
	const serializeField = (field: keyof FilterState, value: unknown): string | undefined => {
		if (value === null || value === undefined) {
			return undefined;
		}
		if (Array.isArray(value)) {
			return value.length > 0 ? value.join(",") : undefined;
		}
		if (typeof value === "object") {
			return Object.keys(value).length > 0 ? JSON.stringify(value) : undefined;
		}
		return value !== "" ? String(value) : undefined;
	};

	/**
	 * Update a single filter field.
	 */
	const setFilter = <K extends keyof FilterState>(field: K, value: FilterState[K]) => {
		navigate({
			search: (prev: Record<string, unknown>) => {
				const next = { ...prev };
				const serialized = serializeField(field, value);
				if (serialized === undefined) {
					delete next[field];
				} else {
					next[field] = serialized;
				}
				// Reset pagination on filter change if offset is present
				if ("offset" in next) {
					next.offset = undefined;
				}
				return next;
			},
			replace: true, // Replace to avoid creating massive history stacks
		});
	};

	/**
	 * Clear a single filter field.
	 */
	const clearFilter = (field: keyof FilterState) => {
		navigate({
			search: (prev: Record<string, unknown>) => {
				const next = { ...prev };
				delete next[field];
				if ("offset" in next) {
					next.offset = undefined;
				}
				return next;
			},
			replace: true,
		});
	};

	/**
	 * Clear all filters.
	 */
	const clearAll = () => {
		navigate({
			search: (prev: Record<string, unknown>) => {
				const next = { ...prev };
				for (const key of Object.keys(EMPTY_FILTER)) {
					delete next[key];
				}
				if ("offset" in next) {
					next.offset = undefined;
				}
				return next;
			},
			replace: true,
		});
	};

	return {
		filters,
		setFilter,
		clearFilter,
		clearAll,
		activeCount,
		toApiParams,
	};
}
