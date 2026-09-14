/**
 * Pagination envelopes for `scroll()` props (#1010).
 *
 * Infinite scroll needs one thing from a prop: the cursor metadata that tells
 * the client which page it is on and which pages exist either side of it
 * ({@link ScrollMetadata}). These two helpers shape a node's return value into
 * that contract so the `scroll()` mode can read it without a resolver.
 *
 * Pure functions on purpose — no `ctx`, no I/O, no database opinion. A node
 * fetches rows however it likes and returns through one of these.
 *
 * ```ts
 * export const listPosts = defineNode({
 *   name: "list-posts",
 *   input: z.object({ page: z.union([z.number(), z.string()]).optional() }),
 *   output: paginatedSchema(PostSchema),
 *   async execute(_ctx, input) {
 *     return paginate(await db.posts(), { page: input.page ?? 1, perPage: 10 });
 *   },
 * });
 * ```
 */

import { z } from "zod";

/**
 * The cursor contract `scroll()` reads off a prop's output.
 *
 * `pageName` is the query-string parameter the client bumps; the three page
 * identifiers are whatever addresses a page in that scheme — a page NUMBER for
 * offset pagination, an opaque STRING for a cursor, `null` when there is no
 * page on that side.
 */
export interface ScrollMetadata {
	pageName: string;
	previousPage: number | string | null;
	nextPage: number | string | null;
	currentPage: number | string | null;
}

const pageIdentifier = z.union([z.number(), z.string(), z.null()]);

/** {@link ScrollMetadata} as Zod — the fields every `scroll()` prop's output must carry. */
export const scrollMetadataSchema = z.object({
	pageName: z.string(),
	previousPage: pageIdentifier,
	nextPage: pageIdentifier,
	currentPage: pageIdentifier,
});

// =============================================================================
// Offset pagination
// =============================================================================

export interface PaginateOptions {
	/** The requested page, 1-based. A query-string string (`"2"`) is accepted. */
	page: number | string;
	/** Items per page. */
	perPage: number;
	/**
	 * Total row count. Supplying it says `items` is ALREADY the page slice (the
	 * database did the paging); omitting it says `items` is the whole
	 * collection, and this function slices it.
	 */
	total?: number;
	/** Query-string parameter the client bumps. Default `"page"`. */
	pageName?: string;
}

/** What {@link paginate} returns: the page's items plus its cursor metadata. */
export interface Paginated<T> extends ScrollMetadata {
	data: T[];
	currentPage: number;
	previousPage: number | null;
	nextPage: number | null;
	perPage: number;
	total: number;
}

/** A positive integer, from anything a query string can hand over. */
function positiveInt(value: number | string, fallback: number): number {
	const parsed = Math.floor(Number(value));
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * Offset-paginate `items` into the envelope `scroll()` reads.
 *
 * With `total` omitted, `items` is the whole collection and the page slice is
 * cut here — the shape a fixture, an in-memory list or a small JSON file wants.
 * With `total` given, `items` is trusted as the page the database returned and
 * is passed through untouched.
 */
export function paginate<T>(items: readonly T[], opts: PaginateOptions): Paginated<T> {
	const perPage = positiveInt(opts.perPage, 1);
	const currentPage = positiveInt(opts.page, 1);
	const total = opts.total === undefined ? items.length : Math.max(0, Math.floor(opts.total));
	const data = opts.total === undefined ? items.slice((currentPage - 1) * perPage, currentPage * perPage) : [...items];
	const lastPage = Math.ceil(total / perPage);
	return {
		data: data as T[],
		pageName: opts.pageName ?? "page",
		currentPage,
		previousPage: currentPage > 1 ? currentPage - 1 : null,
		nextPage: currentPage < lastPage ? currentPage + 1 : null,
		perPage,
		total,
	};
}

/** {@link paginate}'s return value as Zod, for a node's `output` schema. */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
	return scrollMetadataSchema.extend({
		data: z.array(item),
		currentPage: z.number(),
		previousPage: z.number().nullable(),
		nextPage: z.number().nullable(),
		perPage: z.number(),
		total: z.number(),
	});
}

// =============================================================================
// Cursor pagination
// =============================================================================

export interface CursorPaginateOptions {
	/** The cursor this page was fetched with. `null`/omitted on the first page. */
	cursor?: string | number | null;
	/** Cursor for the next page, or `null` at the end. */
	next?: string | number | null;
	/** Cursor for the previous page, or `null` at the start. */
	prev?: string | number | null;
	/** Query-string parameter the client bumps. Default `"cursor"`. */
	pageName?: string;
}

/** What {@link cursorPaginate} returns: the page's items plus its cursor metadata. */
export interface CursorPaginated<T> extends ScrollMetadata {
	data: T[];
}

/**
 * Cursor-paginate `items`. The cursors are opaque strings the caller already
 * computed — this only shapes them into the envelope `scroll()` reads, so a
 * keyset query keeps whatever cursor encoding it likes.
 */
export function cursorPaginate<T>(items: readonly T[], opts: CursorPaginateOptions = {}): CursorPaginated<T> {
	return {
		data: [...items],
		pageName: opts.pageName ?? "cursor",
		currentPage: opts.cursor ?? null,
		previousPage: opts.prev ?? null,
		nextPage: opts.next ?? null,
	};
}

/** {@link cursorPaginate}'s return value as Zod, for a node's `output` schema. */
export function cursorPaginatedSchema<T extends z.ZodTypeAny>(item: T) {
	return scrollMetadataSchema.extend({ data: z.array(item) });
}
