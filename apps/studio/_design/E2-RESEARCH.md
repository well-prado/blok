# E2 (Table system) — research dossier

> Companion to `E2-PREP.md`. Written cold for a future session: assume the reader has
> `E2-PREP.md` open and nothing else.
> **Status: RESEARCH ONLY.** No code was written, no branch cut, no issue touched.
> Baseline: `main` @ `98d35b36`. Everything under "What Blok has today" was read from the
> local checkout on that commit.
>
> Three headings run through the whole document and never blur:
> **[TD]** what trigger.dev actually does · **[BLOK]** what Blok has today · **[REC]** what I recommend.

---

## 0. Provenance — which tool produced which finding

| Finding | Source |
|---|---|
| `Table.tsx` variant table, `TableHeader` sticky classes, `TableProps`/`TableHeaderCellProps`/`TableCellProps` types | **Tetrix** `get_source_code` (module symbol `symbol_02d034cbd0b53068`) for the first ~200 lines; **GitHub contents API** (`mcp__github__get_file_contents`) for the full 651 lines |
| `useTableSort.ts` (complete) | **Tetrix** `get_source_code` (`symbol_91c6d329863b8fb5`) — returned the whole 131-line module |
| `SelectedItemsProvider.tsx` (complete) | **Tetrix** `get_source_code` (`symbol_1bb63c2d2f6289d3`) — whole 147-line module |
| `TruncatedCopyableValue.tsx` (complete) | **Tetrix** `get_source_code` |
| `TreeView.tsx` — virtualization + `getTreeProps`/`getNodeProps` ARIA | **Tetrix** for the head; **GitHub contents API** for the full 646 lines |
| `TaskRunsTable.tsx` (773 lines) — the real consumer | **GitHub contents API** (Tetrix truncated at ~200 lines) |
| `runs._index/route.tsx` — the page that wires selection + bulk | **GitHub contents API** |
| Everything under "What Blok has today" | **local `Read` / `grep`** in `/Users/wellprado/Projects/Personal/blok` |

### 0.1 Tetrix calls that came back empty or wrong — do not repeat them

| Call | Result | Consequence |
|---|---|---|
| `search_code "TableBlankRow"` | `{"results":[]}` | Tetrix does **not** index `export const X = forwardRef(...)` consts. `list_symbols` on `Table.tsx` returns 21 symbols — the `type`s and a handful of `cn` call sites — and **none of the 10 exported components**. Search by *type name* (`TableProps`, `TableVariant`) or fetch the module. |
| `search_code "useVirtualizer"` | `{"results":[]}` | Found only via the *type* `Virtualizer`. Free-text/JSX-prop search does not work; the index is symbol-name based. |
| `search_code "estimateSize getVirtualItems"` | `{"results":[]}` | same reason |
| `search_code "BulkActionBar selected runs toolbar"` | `{"results":[]}` | there is no such component (see §B.3) |
| `search_code "stickyHeader"` | 1 result, and it is a `cn` call *inside* `Table.tsx` | cannot find prop consumers this way |
| `list_files` with `file_path: "apps/webapp/app/components/runs/v3"` | ignored the filter, returned the repo-wide list from `.env.example` down | `file_path` is not a directory filter on `list_files` |
| `get_impact_analysis symbol_name: "TableCell"` | `{"found":false, "nodes":[], "edges":[]}` | `E2-PREP` §2.6 predicted `found:true` + empty graphs; here it was `found:false`. Either way: **unusable, tried once, fell back to reading files.** |
| `mcp__github__search_code` | `MCP error -32603: Authentication Failed` | GitHub *code search* is unavailable. `get_file_contents` works fine unauthenticated on this public repo — use it, it returns whole files where Tetrix truncates at ~200 lines. |

**Practical rule for the E2 agents:** use Tetrix to *locate* (search a type name → get a file path), then `mcp__github__get_file_contents` to *read the whole file*. Tetrix's module fetch silently truncates with a `// ... truncated (N more lines)` marker — an agent that stops there will report a 651-line file as if it ended at line 200.

### 0.2 One thing I could not verify

trigger.dev's `TableHeader` carries a project-local class `safari-only` whose definition lives in their global CSS, not in `Table.tsx`. I did not read it. Everything I say about their Safari sticky path is inferred from the `supports-[(-webkit-hyphens:none)]:after:content-none` sibling class (a Safari-only feature query that *removes* the hairline pseudo-element) — i.e. the hairline trick is known to misbehave in Safari and is disabled there. Treat the mechanism as confirmed and the Safari fallback as unread.

---

# A. `apps/webapp/app/components/primitives/Table.tsx` — the real thing

651 lines, read in full. React 18 idiom throughout (`forwardRef` on all ten exports), Remix `<Link>`, heroicons.

## A.1 The complete exported surface

| Export | Element | Notes |
|---|---|---|
| `Table` | `<div><table>` | provides `TableContext` |
| `TableHeader` | `<thead>` | **the sticky element** |
| `TableBody` | `<tbody>` | `relative overflow-y-auto`, accepts `style` |
| `TableRow` | `<tr>` | `group/table-row`, hairline via `::after` |
| `TableHeaderCell` | `<th scope="col">` | owns sorting UI + `aria-sort` |
| `TableCell` | `<td>` | owns link/button/sticky/lead-trail |
| `CopyableTableCell` | `<td>` | `TableCell` + hover clipboard button |
| `TableCellChevron` | `<td>` | `TableCell alignment="right"` + `›` |
| `TableCellMenu` | `<td>` | the row-actions cell (see §B.3) |
| `TableBlankRow` | `<tr><td colSpan>` | the blank/empty/loading slot |
| `TableVariant` (type) | — | `keyof typeof variants` |

There is **no** `TableFooter`, no `TableCaption`, no virtualization, no selection state, no density prop, no `aria-rowcount`.

## A.2 The variant table, quoted verbatim

This is the single most important block in the file — it is what E2-PREP §4.1 calls "the density ladder".

```tsx
const variants = {
  bright: {
    header: "bg-background-bright",
    headerCell: "px-3 py-2.5 pb-3 text-sm",
    cell: "group-hover/table-row:bg-background-hover group-has-[[tabindex='0']:focus]/table-row:bg-background-hover",
    cellSize: "px-3 py-3",
    cellText: "text-xs group-hover/table-row:text-text-bright",
    stickyCell: "bg-background-bright group-hover/table-row:bg-background-hover",
    menuButton:
      "bg-background-bright group-hover/table-row:bg-background-hover group-hover/table-row:ring-border-bright/70 group-has-[[tabindex='0']:focus]/table-row:bg-background-hover",
    menuButtonDivider: "group-hover/table-row:border-border-bright/70",
    rowSelected: "bg-background-hover group-hover/table-row:bg-background-hover",
  },
  "bright/no-hover": {
    header: "bg-transparent",
    headerCell: "px-3 py-2.5 pb-3 text-sm",
    cell: "group-hover/table-row:bg-transparent",
    cellSize: "px-3 py-3",
    cellText: "text-xs",
    stickyCell: "bg-background-bright",
    menuButton: "bg-background-bright",
    menuButtonDivider: "",
    rowSelected: "bg-background-hover",
  },
  dimmed: {
    header: "bg-background-dimmed",
    headerCell: "px-3 py-2.5 pb-3 text-sm",
    cell: "group-hover/table-row:bg-background-bright group-has-[[tabindex='0']:focus]/table-row:bg-background-bright",
    cellSize: "px-3 py-3",
    cellText: "text-xs group-hover/table-row:text-text-bright",
    stickyCell: "group-hover/table-row:bg-background-bright",
    menuButton:
      "bg-background-dimmed group-hover/table-row:bg-background-bright group-hover/table-row:ring-grid-bright group-has-[[tabindex='0']:focus]/table-row:bg-background-bright",
    menuButtonDivider: "group-hover/table-row:border-grid-bright",
    rowSelected: "bg-background-hover group-hover/table-row:bg-background-hover",
  },
  "compact/mono": {
    header: "bg-background-dimmed",
    headerCell: "px-2 py-1.5 text-sm",
    cell: "group-hover/table-row:bg-background-bright group-has-[[tabindex='0']:focus]/table-row:bg-background-bright",
    cellSize: "px-2 py-1.5",
    cellText: "text-xs font-mono group-hover/table-row:text-text-bright",
    stickyCell: "group-hover/table-row:bg-background-bright",
    menuButton:
      "bg-background-dimmed group-hover/table-row:bg-background-bright group-hover/table-row:ring-grid-bright group-has-[[tabindex='0']:focus]/table-row:bg-background-bright",
    menuButtonDivider: "group-hover/table-row:border-grid-bright",
    rowSelected: "bg-background-hover group-hover/table-row:bg-background-hover",
  },
} as const;
```

**How the nine slots reach the DOM.** `Table` puts `{ variant }` on a React context; every other component does `const { variant } = useContext(TableContext)` and pulls its own slot:

- `header` → `<thead>` className
- `headerCell` → `<th>` className (padding **and** text size)
- `cell`, `cellSize`, `cellText` → all three land on `<td>`; `cellSize` is applied **twice**, once unconditionally via `flexClasses` (the inner flex box for link/button cells) and once in the `else` branch for plain cells (`cn("cursor-default align-middle", variants[variant].cellSize)`)
- `stickyCell` → `<td isSticky>`
- `rowSelected` → `<tr isSelected>` **and** `<td isSelected>`
- `menuButton` / `menuButtonDivider` → the floating action cluster inside `TableCellMenu`

**The finding that matters for E2-PREP §4.1:** `variant` here is **three axes fused into one key**.

| axis | driven by | values in play |
|---|---|---|
| **density** | `headerCell`, `cellSize` | `px-3 py-3` (default) vs `px-2 py-1.5` (compact) |
| **surface / hover behaviour** | `header`, `cell`, `stickyCell`, `rowSelected` | bright vs dimmed vs no-hover |
| **type family** | `cellText` | `font-mono` only in `compact/mono` |

That is precisely the failure `CONVENTIONS.md` §2.10 exists to prevent (`variant` means emphasis, never scale, never status). **Blok MUST split these.** See §F.1.

Second finding: **the header is bigger and brighter than the data.** `headerCell` is `text-sm` + `font-medium text-text-bright`; `cellText` is `text-xs text-text-dimmed`. Studio's six existing tables do the opposite (small-caps dimmed header, larger data). See §F.1 for the call.

## A.3 Prop signatures, quoted

```tsx
type TableProps = {
  containerClassName?: string;
  className?: string;
  children: ReactNode;
  fullWidth?: boolean;
  showTopBorder?: boolean;
  stickyHeader?: boolean;
};
// exported as: forwardRef<HTMLTableElement, TableProps & { variant?: TableVariant }>
// defaults: variant = "dimmed", showTopBorder = true, stickyHeader = false
```

```tsx
type TableRowProps = JSX.IntrinsicElements["tr"] & {
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  isSelected?: boolean;
};
```

```tsx
type TableCellBasicProps = {
  className?: string;
  alignment?: "left" | "center" | "right";
  children?: ReactNode;
  colSpan?: number;
};

type TableHeaderCellProps = TableCellBasicProps & {
  hiddenLabel?: boolean;
  tooltip?: ReactNode;
  /** Extra class merged onto the tooltip content. */
  tooltipContentClassName?: string;
  disableTooltipHoverableContent?: boolean;
  /**
   * When set (together with `onSort`), the header renders a sort indicator and becomes clickable.
   * `"asc"`/`"desc"` show the active direction; `null` shows the neutral (unsorted) affordance.
   * This cell is presentational and fully controlled — the parent owns the sort state (see
   * `useTableSort`).
   */
  sortDirection?: "asc" | "desc" | null;
  /** Invoked when the header is clicked or activated via keyboard. Enables sorting when provided. */
  onSort?: () => void;
};

type TableCellProps = TableCellBasicProps & {
  to?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  hasAction?: boolean;
  isSticky?: boolean;
  actionClassName?: string;
  rowHoverStyle?: string;
  isSelected?: boolean;
  isTabbableCell?: boolean;
  children?: ReactNode;
  leadingContent?: ReactNode;
  trailingContent?: ReactNode;
  style?: React.CSSProperties;
};

type CopyableTableCellProps = TableCellProps & { value: string };

type TableBlankRowProps = { className?: string; colSpan: number; children?: ReactNode };
```

Note `rowHoverStyle?: string` is declared and **never used** in the body — dead prop.

## A.4 Sticky headers — exactly how

The sticky element is the **`<thead>`**, not the `<tr>`, not the `<th>`:

```tsx
<thead
  className={cn(
    "safari-only sticky top-0 z-10 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright supports-[(-webkit-hyphens:none)]:after:content-none",
    variants[variant].header,
    className
  )}
>
```

Four mechanisms, all load-bearing:

1. **`sticky top-0 z-10`** on `<thead>`. `z-10` is the entire z-story in this file; nothing else in `Table.tsx` sets a z-index except the copy-button overlay (`z-10`) and the leading/trailing adornments (`relative z-10`).
2. **An opaque background token** from `variants[variant].header`. `bright/no-hover` uses `bg-transparent` — meaning that variant's sticky header lets rows scroll *through it*. That is a bug they live with, not a feature.
3. **The bottom hairline is a `::after` pseudo-element, not a `border-b`.** This is the interesting part. Tailwind Preflight sets `border-collapse: collapse` on `<table>`; under the collapsed border model the border belongs to the merged grid, not to the sticky box, so a `border-b` on a sticky `<thead>` does not travel with it while scrolling. The `after:absolute after:bottom-0 after:inset-x-0 after:h-px` overlay does.
4. **`supports-[(-webkit-hyphens:none)]:after:content-none`** — a Safari-only feature query that deletes that hairline in Safari, where the `<thead>` pseudo-element misbehaves. `safari-only` (definition unread, §0.2) presumably supplies the replacement.

**The sharp edge:** `Table` flips its own overflow based on `stickyHeader`:

```tsx
stickyHeader ? "overflow-visible" : "overflow-x-auto",
```

A `sticky` element is positioned against its **nearest scrolling ancestor**. If the table's own wrapper scrolls (`overflow-x-auto` establishes a scroll container in both axes), the `<thead>` sticks to that wrapper and never moves relative to the page. So enabling `stickyHeader` **removes** the table's own scroll container and hands vertical scrolling to an ancestor. The consumer supplies it: `TaskRunsTable` passes `className="max-h-full overflow-y-auto"` onto the `<table>` element itself. So there are two competing scroll owners depending on a boolean — an implicit contract with no type to enforce it.

## A.5 Row-level links and navigation

There is no "row link". **Navigation is per-cell and repeated.** In `TaskRunsTable`, sixteen cells each get `to={path}` with the *same* path:

```tsx
<TableCell to={path} isTabbableCell>
  <TruncatedCopyableValue value={run.friendlyId} />
</TableCell>
<TableCell to={path}>{run.version ?? "–"}</TableCell>
<TableCell to={path}>{run.startedAt ? <DateTime date={run.startedAt} /> : "–"}</TableCell>
```

Inside `TableCell`, `to` renders a Remix `<Link>` that fills the cell:

```tsx
<Link
  to={to}
  className={cn("cursor-pointer focus:outline-hidden", flexClasses, actionClassName)}
  tabIndex={isTabbableCell ? 0 : -1}
>
```

**`isTabbableCell` is the whole keyboard model.** Exactly one cell per row passes it, so the row is one Tab stop; the other fifteen links are `tabIndex={-1}` (reachable by mouse and by screen-reader virtual cursor, not by Tab). That is a genuinely good idea and E2 should keep it.

When a cell needs both a link and an interactive adornment, `leadingContent`/`trailingContent` render **outside** the `<a>` and the link becomes a stretched overlay:

```tsx
<Link
  to={to}
  className={cn(
    "inline-flex items-center gap-2 before:absolute before:inset-0 before:content-[''] focus:outline-hidden",
    actionClassName
  )}
  tabIndex={isTabbableCell ? 0 : -1}
>
```
with the adornments lifted above it (`<span className="relative z-10 …">`). The source comment states the reason plainly: interactive triggers must never nest inside an `<a>` — "invalid DOM that fails a11y audits".

## A.6 Cell truncation + copy

Two layers, neither inside `Table.tsx` proper:

- `CopyableTableCell` — a `TableCell` whose children sit in a `relative flex` box with local `isHovered` state; on hover it absolutely positions a 24px clipboard button at `-right-2`, wired to `useCopy(value)`. The click handler does `e.stopPropagation(); e.preventDefault(); copy()` so it does not trigger the cell's link.
- `TruncatedCopyableValue` (`primitives/TruncatedCopyableValue.tsx`, 27 lines) — the pattern the runs table actually uses. **Tail truncation, not middle**:

```tsx
<SimpleTooltip
  content={value}
  button={
    <span className={cn("flex h-6 items-center gap-1", className)}>
      <CopyableText value={value.slice(-length)} copyValue={value} className="font-mono" />
    </span>
  }
  asChild
  disableHoverableContent
/>
```
`length` defaults to `8`. The full value goes to the clipboard and to the tooltip; only the last 8 chars are shown.

## A.7 Row hover and focus, as styled

- The `<tr>` carries `group/table-row relative w-full outline-hidden` plus a `::after` hairline **inset by 12px on the left** (`after:left-3 after:right-0 after:h-px after:bg-grid-dimmed`).
- Hover and focus backgrounds are painted **per cell**, not on the row: every `<td>` carries `variants[variant].cell`, which is a pair of `group-hover/table-row:bg-*` + `group-has-[[tabindex='0']:focus]/table-row:bg-*` classes.
- Because the row hairline is inset 12px, each `<td>` then carries ~450 characters of `::before`/`::after` patching to fill that 12px gutter with the hover colour and with the focus hairline:

```tsx
"has-[[tabindex='0']:focus]:before:absolute has-[[tabindex='0']:focus]:before:-top-px has-[[tabindex='0']:focus]:before:left-0 has-[[tabindex='0']:focus]:before:h-px has-[[tabindex='0']:focus]:before:w-3 …"
```

- The focus signal is `group-has-[[tabindex='0']:focus]/table-row` — i.e. *"some descendant with `tabindex=0` has focus"*. Not `:focus-visible`, not `:focus-within`. So a **mouse click** on a row's primary link also paints the focus background.
- `<tr>` never carries `tabIndex`. `<th>` carries `tabIndex={-1}` (pointless — a `<th>` is not focusable by default; this only makes it programmatically focusable).

**This is the single biggest simplification available to Blok.** A `<tr>` can carry `bg-*` directly and it paints in every current browser. Most of that per-cell string exists because the row hairline is inset and the sticky cell needs its own opaque background. Put the hover/selected background on the `<tr>`, draw the separator with `border-b` on the `<td>` (Studio already does exactly this on five screens), and give only the sticky cell an explicit background. **MUST be verified in a browser** — see §G.6.

---

# B. Sort · selection · row actions · blank states

## B.1 Sort — `primitives/useTableSort.ts` (131 lines, read whole)

Sort is **split in two**: a presentational `<TableHeaderCell sortDirection onSort>` (§A.3) and a standalone hook. The header cell is fully controlled and owns no state.

```tsx
export type SortDirection = "asc" | "desc";
export type SortState<K extends string = string> = { key: K; direction: SortDirection };

export type SortColumn<T, K extends string = string> =
  | { key: K; type: "number"; value: (row: T) => number | null | undefined }
  | { key: K; type: "alpha";  value: (row: T) => string | null | undefined }
  | { key: K; type: "custom"; compare: (a: T, b: T) => number };

/** Presentational props to spread onto a `<TableHeaderCell>` for a given column. */
export type TableSortHeaderProps = { sortDirection: SortDirection | null; onSort: () => void };

export function useTableSort<T, K extends string = string>(
  rows: T[],
  columns: ReadonlyArray<SortColumn<T, K>>
) // → { sortedRows, getSortProps, sort }
```

Behaviours worth copying, all verified in the source:

- **Three-state cycle:** `asc → desc → cleared`. Cleared returns the *incoming* row order, so a server default is always reachable without a reload.
- **Stable sort**, implemented by decorating with the original index and tie-breaking on it (`sortRows`).
- **Nulls always sort last, in both directions** — the `sign` is applied to the comparison but not to the null branch.
- `alpha` uses `localeCompare(…, { sensitivity: "base" })`, i.e. case- and accent-insensitive.
- `sortRows` and `compareColumn` are exported **pure functions** so the ordering can be unit-tested without rendering. There is a real test at `apps/webapp/test/useTableSort.test.ts` (56 lines).

The header renders three icon states — `ChevronUpIcon` / `ChevronDownIcon` / `ChevronUpDownIcon` (neutral) — and sets `aria-sort` on the `<th>`:

```tsx
aria-sort={
  sortable
    ? sortDirection === "asc" ? "ascending"
    : sortDirection === "desc" ? "descending"
    : "none"
    : undefined
}
```

## B.2 Selection — `primitives/SelectedItemsProvider.tsx` (147 lines, read whole)

**Context + `useReducer`, provided ABOVE the table**, not by the table.

```tsx
type SelectedItemsContext = {
  selectedItems: Set<string>;
  select: (items: string | string[]) => void;
  deselect: (items: string | string[]) => void;
  toggle: (items: string | string[]) => void;
  deselectAll: () => void;
  has: (item: string) => boolean;
  hasAll: (items: string[]) => boolean;
};

export function SelectedItemsProvider({
  initialSelectedItems,
  maxSelectedItemCount,
  children,
}: {
  initialSelectedItems: string[];
  maxSelectedItemCount?: number;
  children: React.ReactNode | ((context: SelectedItemsContext) => React.ReactNode);
})
```

- The provider supports a **render-prop child** — that is how the page reads `selectedItems` for the toolbar while the table reads it via `useSelectedItems()`.
- `maxSelectedItemCount` is enforced by `cappedSet`, which `console.warn`s and **silently truncates** past the cap.
- `useSelectedItems(enabled = true)` throws outside a provider unless `enabled` is `false` — that is how `TaskRunsTable` supports `allowSelection={false}`: `const { has, hasAll, select, deselect, toggle } = useSelectedItems(allowSelection)`. When `allowSelection` is false it gets `{}` and never calls into it. **Sloppy — it returns an untyped empty object cast to the context type.**

The call site (`TaskRunsTable`, header cell + body cell):

```tsx
{allowSelection && (
  <TableHeaderCell className="pl-3 pr-0">
    {runs.length > 0 && (
      <Checkbox
        checked={hasAll(runs.map((r) => r.friendlyId))}
        onChange={(element) => {
          const ids = runs.map((r) => r.friendlyId);
          const checked = element.currentTarget.checked;
          if (checked) { select(ids); } else { deselect(ids); }
        }}
        ref={(r) => { checkboxes.current[0] = r; }}
        onKeyDown={(event) => navigateCheckboxes(event, 0)}
      />
    )}
  </TableHeaderCell>
)}
```

```tsx
{allowSelection && (
  <TableCell className="pl-3 pr-0">
    <Checkbox
      checked={has(run.friendlyId)}
      onChange={() => { toggle(run.friendlyId); }}
      ref={(r) => { checkboxes.current[index + 1] = r; }}
      onKeyDown={(event) => navigateCheckboxes(event, index + 1)}
    />
  </TableCell>
)}
```

Keyboard range-select is a hand-rolled ref array on the checkboxes:

```tsx
const checkboxes = useRef<(HTMLInputElement | null)[]>([]);

const navigateCheckboxes = useCallback(
  (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    //indexes are out by one because of the header row
    if (event.key === "ArrowUp" && index > 0) {
      checkboxes.current[index - 1]?.focus();
      if (event.shiftKey) { /* select(oldItem, newItem) */ }
    } else if (event.key === "ArrowDown" && index < checkboxes.current.length - 1) {
      checkboxes.current[index + 1]?.focus();
      …
    }
  },
  [checkboxes, runs]
);
```

Note: `select` is used inside but omitted from the dep array; and the `ArrowDown` shift branch reads `runs.at(index - 1)` / `runs.at(index)` where `ArrowUp` reads `index - 1` / `index - 2` — the off-by-one comment is doing a lot of work. **Do not copy this function.** Range-select belongs in the hook (§F.3).

There is **no `aria-selected`** anywhere, and no accessible name on any of these checkboxes.

## B.3 Row actions — `TableCellMenu` + the consumer's `RunActionsCell`

`TableCellMenu` is a `TableCell` with `isSticky`, `alignment="right"`, `hasAction`, containing an absolutely-positioned cluster:

```tsx
forwardRef<HTMLTableCellElement, TableCellProps & {
  className?: string;
  isSticky?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  visibleButtons?: ReactNode;
  hiddenButtons?: ReactNode;
  popoverContent?: ReactNode | ((close: () => void) => ReactNode);
  children?: ReactNode;
  isSelected?: boolean;
}>
```

Three slots, three behaviours:

- `hiddenButtons` — wrapped in `data-hidden-buttons` and `hidden group-hover/table-row:block`; revealed on row hover only. **Not keyboard reachable while hidden** (`display:none` removes it from the tab order and there is no `focus-within` escape hatch). Real a11y bug.
- `visibleButtons` — always rendered.
- `popoverContent` — a Radix-ish `Popover` with `PopoverVerticalEllipseTrigger` (the `⋮`), always visible. Accepts a function `(close) => ReactNode` so items can close the popover.

`isSticky` also toggles a width hack that keys off the hidden-buttons marker: `"[&:has([data-hidden-buttons])]:w-auto sticky right-0 bg-background-dimmed"`.

The consumer supplies content, not chrome:

```tsx
<RunActionsCell run={run} path={path} canCancelRuns={canCancelRuns} canReplayRuns={canReplayRuns} />
```
…which returns `<TableCellMenu isSticky popoverContent={…} hiddenButtons={…} />`, or, when the run has no actions, a plain `<TableCell to={path}>{""}</TableCell>` so the column still exists.

**There is no "bulk action bar" component.** `search_code "BulkActionBar"` → empty, and the runs page confirms why: selection drives (a) a count `Badge` inside a normal toolbar button, and (b) a **resizable side panel**, not a floating bar:

```tsx
<div
  className={cn(
    "grid h-full max-h-full overflow-hidden",
    selectedItems.size === 0 ? "grid-rows-1" : "grid-rows-[1fr_auto]"
  )}
>
```
```tsx
<span className="flex items-center gap-x-1 whitespace-nowrap text-text-bright">
  <span>Bulk action</span>
  {selectedItems.size > 0 && <Badge variant="rounded">{selectedItems.size}</Badge>}
</span>
```

So **#782's "bulk action bar" has no reference implementation.** Blok's own `runs/BulkActionToolbar.tsx` is closer to what the ticket describes than anything in trigger.dev.

## B.4 Blank states — `TableBlankRow`, inside the body

```tsx
export const TableBlankRow = forwardRef<HTMLTableRowElement, TableBlankRowProps>(
  ({ children, colSpan, className }, ref) => {
    return (
      <tr ref={ref}>
        <td colSpan={colSpan} className={cn("py-6 text-center text-sm", className)}>
          {children}
        </td>
      </tr>
    );
  }
);
```

The blank state lives **inside `<TableBody>`**, so the header, the column widths and the sticky behaviour all survive an empty result. The consumer branches three ways:

```tsx
<TableBody>
  {total === 0 && !hasFilters ? (
    <TableBlankRow colSpan={showRegion ? 16 : 15}>
      {!isLoading && <NoRuns title="No runs found" />}
    </TableBlankRow>
  ) : runs.length === 0 ? (
    <BlankState isLoading={isLoading} filters={filters} showRegion={showRegion} />
  ) : (
    runs.map((run, index) => { … })
  )}
  {isLoading && (
    <TableBlankRow
      colSpan={showRegion ? 16 : 15}
      className="absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-background-dimmed"
    >
      <Spinner /> <span className="text-text-dimmed">Loading…</span>
    </TableBlankRow>
  )}
</TableBody>
```

Three distinct states, exactly the split E2-PREP §4.5 asks about:

1. **"nothing yet"** (`total === 0 && !hasFilters`) → `<NoRuns title="No runs found" />`
2. **"no results for this filter"** (`runs.length === 0` with filters) → `<BlankState>`, which further special-cases a single-task filter and otherwise offers **Refresh** + **Run a test** buttons
3. **loading** → an overlay `TableBlankRow` positioned `absolute inset-0` over the body (this is why `TableBody` is `relative`)

`colSpan={showRegion ? 16 : 15}` is hand-counted in **four** places in one file. This is a bug farm; §F.2 removes it.

## B.5 The consumer screen, quoted

`apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/route.tsx`:

```tsx
<PageBody scrollable={false}>
  <SelectedItemsProvider initialSelectedItems={[]} maxSelectedItemCount={BULK_ACTION_RUN_LIMIT}>
    {({ selectedItems }) => (
      <Suspense fallback={…}>
        <TypedAwait resolve={data} errorElement={…}>
          {(list) => <RunsList list={list} selectedItems={selectedItems} … />}
        </TypedAwait>
      </Suspense>
    )}
  </SelectedItemsProvider>
</PageBody>
```

and inside `RunsList`:

```tsx
<TaskRunsTable
  total={visibleRuns.length}
  hasFilters={list.hasFilters}
  filters={list.filters}
  runs={visibleRuns}
  childrenStatusesBasePath={childrenStatusesBasePath}
  isLoading={isLoading}
  allowSelection
  rootOnlyDefault={rootOnlyDefault}
  canCancelRuns={canCancelRuns}
  canReplayRuns={canReplayRuns}
/>
```

`TaskRunsTable` itself never calls `useTableSort` — the runs list is **server-sorted and cursor-paginated** (`ListPagination list={list}`, `cursor`/`direction` search params). Sorting via `useTableSort` is used by *other*, smaller tables. That matters for §C.

---

# C. Virtualization — the answer, plainly

## C.1 [TD] trigger.dev does **NOT** virtualize its tables

Read in full: `Table.tsx` (651 lines) contains no virtualizer, no windowing, no measurement, no scroll math. `TaskRunsTable.tsx` (773 lines) renders `runs.map((run, index) => …)` — every row, always. `search_code "useVirtualizer"` returns nothing anywhere in the repo except through the `Virtualizer` type.

They get away with it because **the runs list is cursor-paginated on the server.** The DOM never holds more than one page.

## C.2 [TD] Where it DOES virtualize: the span TreeView

`apps/webapp/app/components/primitives/TreeView/TreeView.tsx` (646 lines), using **`@tanstack/react-virtual`**:

```tsx
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { useVirtualizer } from "@tanstack/react-virtual";
```

The virtualizer is created in `useTree()` and **passed into `<TreeView>` as a prop** — the view is a pure renderer:

```tsx
const virtualizer = useVirtualizer({
  count: state.visibleNodeIds.length,
  getItemKey: (index) => state.visibleNodeIds[index],
  getScrollElement: () => parentRef.current,
  estimateSize: (index: number) => {
    const treeItem = tree[index];
    if (!treeItem) return 0;
    return estimatedRowHeight({ node: treeItem, state: state.nodes[treeItem.id], index });
  },
  overscan: 50,
});
```

The DOM shape is the classic two-div sandwich — **not a table**:

```tsx
<div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative", overflowY: "visible" }}>
  <div style={{ position: "absolute", top: 0, left: 0, width: "100%",
                transform: `translateY(${virtualItems.at(0)?.start ?? 0}px)` }}>
    {virtualItems.map((virtualItem) => (
      <div key={node.id} data-index={virtualItem.index} ref={virtualizer.measureElement} className="overflow-clip" {...getNodeProps(node.id)}>
        {renderNode({ node, state, index: virtualItem.index, virtualizer, virtualItem })}
      </div>
    ))}
  </div>
</div>
```

Its a11y is `role="tree"`, not a grid:

```tsx
const getTreeProps = useCallback(() => ({
  role: "tree",
  "aria-multiselectable": true,
  tabIndex: -1,
  onKeyDown: (e) => { /* Home / End / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Escape */ },
}), [state]);

const getNodeProps = useCallback((id: string) => ({
  "aria-expanded": node.expanded,
  "aria-level": treeItem.level + 1,
  role: "treeitem",
  tabIndex: node.selected ? -1 : undefined,
}), [state, treeIndexById]);
```

**No `aria-setsize`, no `aria-posinset`** — so their virtualized tree does *not* keep position/count honest. There is nothing to copy here on the a11y side; that is a gap Blok can beat.

Also note: the whole tree is `tabIndex: -1` and selection moves via `dispatch`, not via DOM focus. Focus never lives on a windowed node, which is exactly how they sidestep the "focused row got recycled" problem. That is a legitimate technique (see §F.4).

## C.3 [BLOK] Studio already has both pieces

- `@tanstack/react-virtual": "^3.11.0"` is **already a dependency** (`apps/studio/package.json` line 22). **T6 needs no new dependency**, which retires CONVENTIONS §0.1 as an objection.
- Studio already virtualizes a list: `src/components/trace/StepRail.tsx`, and the pattern there is the one to reuse:

```tsx
const VIRTUALIZE_THRESHOLD = 50;
const ROW_HEIGHT = 30;
…
const useVirtual = railItems.length >= VIRTUALIZE_THRESHOLD;
const virtualizer = useVirtualizer({
  count: useVirtual ? railItems.length : 0,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => ROW_HEIGHT,
  overscan: 8,
});
```

The `count: useVirtual ? … : 0` gate is doing something important that nobody wrote down: **below the threshold the virtualizer measures nothing, so jsdom never needs `ResizeObserver`.** `src/__tests__/setup.ts` has no `ResizeObserver` polyfill (I read it), and `components.test.tsx` renders `StepRail` with a handful of nodes — which is the only reason those tests pass. Two sibling tests say so out loud (`WorkflowGraph.fitView.test.tsx`: "run its layout/measurement pipeline in jsdom — no ResizeObserver").

- `@tanstack/react-table": "^8.20.0"` is also a dependency, used by exactly one file (`RunsTable.tsx`). Once E2 replaces it, that dependency becomes removable.

## C.4 [REC] Recommendation — **option (a′): seam in T1, windowing in T6, threshold-gated**

**Decide (a), with one modification, and tell the founder the modification.**

Ship the seam in T1, on day one, at a cost of about six lines:

```
<TableBody> accepts EITHER `children` (compose-it-yourself; catalog demos, tiny tables)
            OR      `rows: T[]` + `renderRow: (row: T, index: number) => ReactNode`.
When `rows` is given, TableBody owns the loop — and therefore owns windowing later.
```

Then T6 changes **only `TableBody`'s internals**. No public API change, no other file touched, no re-review of T2–T5/T7.

Reasoning, in order of weight:

1. **T6 is funded and in the same epic.** The seam is not speculative (ponytail rung 1 does not apply); it is the difference between T6 being a 40-line diff in one file and a rewrite of the rendering model after five features have landed on it. E2-PREP §3 already reached this conclusion; the research confirms the cost is genuinely small.
2. **Table windowing is structurally different from TreeView windowing** and cannot be back-fitted casually. You cannot put a translated `<div>` inside `<tbody>`. The technique is **two spacer `<tr>`s** with a `style={{ height }}` `<td>`, above and below the rendered window. That preserves real `<table>` semantics *and* the sticky `<thead>` (which sticks to the scroll container, not to the rows). Trying to reach that from a `children`-only `<TableBody>` means every caller changes.
3. **Threshold-gate it exactly like `StepRail`.** `VIRTUALIZE_THRESHOLD = 100` for tables (rows are ~40px, so 100 rows ≈ 4000px ≈ 4 viewports — well past where it matters, and comfortably above every current page size). Below the threshold: render every row, no measurement, no `ResizeObserver`, jsdom-testable. Above: window. **This is what makes T6 shippable at all given §G.5.**
4. **`estimateSize` returns the density ladder's row height** — which is the second reason §F.1's ladder must be expressed as a fixed `h-*` per density rather than as padding. A padding-derived height is not a number T6 can hand to `estimateSize`.
5. **Do not virtualize horizontally.** Column virtualization buys nothing at 16 columns and breaks sticky columns and `colSpan`.

**The modification the founder must hear:** on today's data, T6 is not needed. Every Studio table is paginated (`RunsTable` takes `page`/`limit`/`total`; logs, queues, deployments, scheduled are all fixed-window lists), so the DOM never holds more than ~50 rows. trigger.dev, at far greater scale, chose pagination over virtualization for exactly this reason. **So: build the seam in T1 (cheap, prevents the expensive refactor), and consider deferring T6's implementation until a screen actually renders >100 rows — e.g. the logs stream, which is the one genuinely unbounded list in Studio.** That is a strictly cheaper plan than either option in E2-PREP §3 and it keeps the option open.

---

# D. Table a11y

## D.1 [TD] What trigger.dev actually ships

| Question | Answer |
|---|---|
| Real `<table>` or ARIA grid? | **Real `<table>` semantics.** `<table>/<thead>/<tbody>/<tr>/<th scope="col">/<td>`. No `role="grid"`, no `role` overrides anywhere in `Table.tsx`. |
| Where does focus live? | **On one link inside one cell per row** (`isTabbableCell` → `tabIndex={0}`; every other in-row link `tabIndex={-1}`). The `<tr>` is never focusable. `<th>` carries a pointless `tabIndex={-1}`. |
| `aria-sort` | **Yes**, on sortable `<th>` only, `ascending`/`descending`/`none`. Correct. |
| `aria-selected` | **Absent.** Selection is conveyed only by the checkbox. |
| `aria-rowcount` / `aria-rowindex` / `aria-colcount` | **Absent.** Correct, given no virtualization — the DOM is the truth. |
| Row keyboard nav (arrows) | **Absent on rows.** Arrow keys work only *between the selection checkboxes* (`navigateCheckboxes`), and only when `allowSelection` is on. |
| Hidden row actions | `hidden group-hover/table-row:block` — `display:none`, so **keyboard-unreachable**. |

## D.2 [TD] What they get wrong — Blok's chance to beat the reference

1. **Every sort button has the same accessible name.** `aria-label="Toggle sort"`, on every sortable column. A screen-reader user hears "Toggle sort, button" N times with no idea which column. → Blok: name the column.
2. **The sort target is the arrow glyph, not the header.** Their own comment: *"Only the sort arrows toggle sorting — the label (and info tooltip) are not clickable, so clicking the header text does nothing."* The hit target is a ~16px chevron, below WCAG 2.2 AA 2.5.8's 24×24 minimum, and it violates every user's expectation that a column header is clickable. → Blok: the whole `<th>` content is the button.
3. **Selection checkboxes have no accessible name.** In `TaskRunsTable` the `<Checkbox>` gets `checked`/`onChange`/`ref`/`onKeyDown` and nothing else. AT announces "checkbox, not checked". The select-all in the header is equally anonymous. → Blok gets this for free: `primitives/Checkbox.tsx` makes `label` **required** ("Required: an unlabelled checkbox is a bug, not a variant"). An accidental structural win — keep it.
4. **Hover-revealed row actions are keyboard-unreachable.** `display:none` until `:hover`. → Blok: reveal on `group-focus-within` too, or keep the action trigger always rendered and only fade its opacity (opacity keeps it focusable).
5. **`colSpan` is hand-counted**, four times in one file, guarded by nothing. → §F.2.
6. **The row "focus" style fires on mouse click**, because it keys off `:focus`, not `:focus-visible`. → Blok: `:focus-visible`, per CONVENTIONS §3.4 which already mandates it for controls.
7. **Their virtualized surface (TreeView) sets no `aria-setsize`/`aria-posinset`.** Nothing to copy; do it properly (§F.4).

## D.3 [REC] How virtualization keeps `aria-rowcount`/`aria-rowindex` honest

The rules, and the part everyone gets wrong:

- `aria-rowcount` goes on the **`<table>`** and counts **every row that would exist, including the header row**. If there are 5,000 data rows and one header row, it is `5001`. `-1` is the legal value for "unknown".
- `aria-rowindex` goes on each rendered **`<tr>`** and is **1-based, with the header row as index 1**. So the first data row is `aria-rowindex={2}`, and data row *i* (0-based) is `i + 2`. Off-by-one here is the standard bug.
- The two **spacer `<tr>`s** that create the scroll height carry `aria-hidden="true"` and **no** `aria-rowindex`.
- Set them **only when the DOM is incomplete**. Non-virtualized table where every row is in the DOM → set neither; the DOM is already the truth and the attributes are just a second place to be wrong. Server-paginated with a complete page in the DOM → also set neither (page-local indices with a global count is the worst of both).
- `aria-colcount`/`aria-colindex`: not needed. Blok never windows columns (§C.4.5).

---

# E. What Blok has today (local reading only)

`github:well-prado/blok` is stale (2026-08-10) and contains none of E1 — everything below was read from the working checkout.

## E.1 `src/components/runs/RunsTable.tsx` — 396 lines, the thing being replaced

```tsx
interface RunsTableProps {
  runs: WorkflowRun[];
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
  showWorkflow?: boolean;
  enableCompare?: boolean;
  enableBulk?: boolean;
}
```

What it is today:

- Built on **`@tanstack/react-table` v8** — `useReactTable`, `ColumnDef[]`, `flexRender`, `getCoreRowModel`, `getSortedRowModel`. The only consumer of that dependency in the repo.
- Sorting is `useState<SortingState>` + `getSortedRowModel()`. **Every** header renders an `ArrowUpDown` icon and a sort button, including non-sortable ones, and there is no `aria-sort`.
- Two independent selection models: `compareSelection: string[]` (max 2, for the diff view) and `bulkSelection: Set<string>` (for `BulkActionToolbar`). `enableCompare && !enableBulk` gates which is shown.
- Escape-clears-selection is a `window.addEventListener("keydown")` in a `useEffect`, guarded against firing inside inputs.
- Checkboxes are hand-rolled `<button>`s with a `Check` icon and `title="Select"` — **`title=` as the only label, which CONVENTIONS §9 bans**, and no `role="checkbox"`/`aria-checked`.
- Row navigation is a `<Link to="/runs/$runId">` wrapping the contents of **every cell except the checkbox cells** — so each row is 6–7 tab stops.
- Raw colours everywhere: `border-zinc-800`, `text-zinc-500`, `bg-blok-green-500`, `text-[#00231b]`. All banned by CONVENTIONS §3.2 in new files (this file predates the guard and is out of its scope).
- Pagination UI is inline at the bottom.
- The empty state is **outside** the component — both callers branch before rendering it.

Call sites (2, both identical in shape):

```tsx
// src/routes/runs/index.tsx:44
<RunsTable runs={data.runs} total={data.total} page={page} limit={limit}
           onPageChange={setPage} showWorkflow enableBulk />

// src/routes/workflows/$name.tsx:149
<RunsTable runs={runsData.runs} total={runsData.total} page={page} limit={limit}
           onPageChange={setPage} enableCompare />
```

Both are wrapped in `runsData.runs.length > 0 ? <RunsTable …/> : <EmptyState …/>`.

`src/components/runs/BulkActionToolbar.tsx` — `({ selectedIds, runs, onClear })`, renders **above** the table, not floating. It is closer to #782's brief than anything in trigger.dev.

## E.2 Every table-like list in Studio today

`grep -rl "<table" src/` → six files. Their densities are the raw material for §F.1.

| File | header treatment | cell padding | cell text | row separator |
|---|---|---|---|---|
| `components/runs/RunsTable.tsx` | `px-3 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wider` | `px-3 py-2.5` | table `text-sm` | `border-b border-zinc-800/50` |
| `routes/logs.tsx` | `sticky top-0 bg-overlay z-10` | `px-3 py-1.5` | table `font-mono text-[12px]` | — |
| `routes/queues.tsx` | `bg-canvas/60` | `px-3 py-2.5` | table `text-sm`, cells `font-mono text-[12px]` | `border-t border-zinc-800` |
| `routes/deployments.tsx` | `bg-canvas/60` | `px-3 py-2.5` | table `text-sm` | `border-t border-zinc-800` |
| `routes/scheduled.tsx` | `bg-raised text-zinc-400 text-xs uppercase tracking-wide`, `px-4 py-2.5` | `px-4 py-2.5` | table `text-sm` | `border-t border-zinc-800` |
| `components/metrics/NodePerformance.tsx` | `px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600` | `px-2 py-2` | table `text-sm` | `border-b border-zinc-800/50` |

Three real densities exist in the wild: **`px-2 py-1.5` compact (logs, NodePerformance)**, **`px-3 py-2.5` default (RunsTable, queues, deployments)**, **`px-4 py-2.5` roomy (scheduled)**. Four of six use a small-caps dimmed header. `routes/logs.tsx` is the only one with a sticky header today, and it does it the simple way: `<thead className="sticky top-0 bg-overlay z-10">`.

## E.3 The E1 primitives E2 will consume — exact paths and APIs on `main`

All import via the `@/` alias. **No barrel — full paths only** (CONVENTIONS §5.1).

```tsx
import { Checkbox }            from "@/components/primitives/Checkbox";
import { SimpleDropdownMenu, DropdownMenuItem, type DropdownMenuEntry }
                               from "@/components/primitives/DropdownMenu";
import { Button, LinkButton }  from "@/components/primitives/Buttons";
import { EmptyState }          from "@/components/primitives/EmptyState";
import { Badge, StatusBadge }  from "@/components/primitives/Badge";
import { CopyButton, useCopy } from "@/components/primitives/CopyButton";
import { CopyableText }        from "@/components/primitives/CopyableText";
import { MiddleTruncate }      from "@/components/primitives/MiddleTruncate";
import { SimpleTooltip }       from "@/components/primitives/Tooltip";
import { Spinner }             from "@/components/primitives/Spinner";
import { cn }                  from "@/lib/utils";
```

**`Checkbox`** — `Omit<React.ComponentPropsWithRef<"input">, "size" | "type"> & { size?: "xs"|"sm"|"md"|"lg"; label: ReactNode; description?: ReactNode; containerClassName?: string }`.
`label` is **required** and always rendered visibly in a sibling `<div>`. For a table cell, pass a screen-reader-only node: `label={<span className="sr-only">Select run {id}</span>}`. `size` takes the **icon column** of §2.4 (`md` → `h-4 w-4`), like `Spinner`. Forwards `ref` to the real `<input>` — needed for `indeterminate` (§G.3).

**`SimpleDropdownMenu`** — `React.ComponentProps<typeof MenuPrimitive.Root> & { trigger: ReactNode; items: DropdownMenuEntry[]; label?: string; align?: …; className?: string }`, where
`DropdownMenuEntry = { label: string; onSelect: () => void; icon?: ComponentType<{className?, "aria-hidden"?}>; disabled?: boolean; tone?: "neutral"|"error"|… }`.
This is #781's whole menu — do not build another. `trigger` goes through `asChild`, so pass a real `<button>`.

**`EmptyState`** — `{ icon: ReactNode; title: string; description: string|ReactNode; action?: ReactNode; className?: string; snippets?: {lang,code}[]; docLink?: {href,label}; align?: "center"|"left" }`. Renders an `<h3>` (safe inside a `<td>`; see §G.2). #784 **composes** this — it does not create a second empty state.

**`Badge`** — `variant?: "primary"|"secondary"|"minimal"` (default `secondary`), `size?: "xs"|"sm"|"md"` (default `md`). **`StatusBadge`** — `{ status: WorkflowRunStatus|NodeRunStatus; className? }`, consumes `STATUS_COLORS`/`STATUS_DOT_COLORS`/`STATUS_LABELS` from `@/lib/constants`.

**`CopyButton`** — `{ value: string; variant?: "secondary"|"minimal" (default minimal); size?: "xs"|"sm"|"md" (default md); children? }`; children omitted ⇒ icon-only square. **`CopyableText`** — `{ value; copyValue?; mono? }`, the whole label is the button. **`useCopy(value, duration=1500)` → `{ copy, state, announcement }`** — the one clipboard state machine; do not grow a second one (CONVENTIONS §12.4 records that exact mistake).

**`MiddleTruncate`** — `{ text: string; maxLength?: number (24) }` plus `middleTruncate(text, maxLength)` as a pure function. Its screen-reader twin carries `select-none` so a mouse-drag cannot copy both strings; that fix is already in.

**Missing:** there is **no `Text.tsx`** in `src/components/primitives/`, despite CONVENTIONS §12.1 assigning `Text.tsx` (mono/numeric) to E1-T4. It did not ship. E2 needs monospace + tabular numerals for id/duration/count columns; until a primitive exists, use `font-mono` / `tabular-nums` utilities directly on the cell and **report the gap** rather than inventing a primitive inside E2.

## E.4 The vocabulary E2 must reuse, not reinvent

- **§2.4 size ladder** — `xs` `h-6 px-2 text-xs` · `sm` `h-7 px-2.5 text-xs` · `md` `h-8 px-3 text-sm` · `lg` `h-9 px-4 text-sm`; `md` is the audited default; glyph-only primitives take only the icon column.
- **§2.4a text ladder** — `sm` `text-xs` · `md` `text-sm` · `lg` `text-base`.
- **§2.5 radius** — pills `rounded-full`, everything else `rounded-md`. Nothing else.
- **§2.9 elevation** — three tiers, one border token (`border-line`) on every floating surface, `z-50` on every portal.
- **§2.10 prop axes** — `variant` = emphasis (`primary`/`secondary`/`minimal`/`error`), `tone` = semantic status (`neutral`/`info`/`success`/`warning`/`error`), `ink` = text colour (`default`/`strong`/`dimmed`/`muted`), `size` = scale. **Red is `error`, never `danger`.** A prop name means the same thing in every primitive.
- **Tokens** — surfaces `canvas`/`raised`/`overlay`/`hover`/`control`; ink `ink-strong`/`ink`/`ink-dimmed`/`ink-muted`/`ink-faint` (**`ink-faint` is not a text token**); lines `line`/`line-strong`/`line-bright`; `accent`/`accent-hover`/`on-accent`; `status-*` fill + `status-*-ink` text, `log-{debug,info,warn,error}`.
- **`.focus-ring`** (`app.css` `@utility`): `outline: 1px solid var(--color-focus-ring); outline-offset: -1px; border-radius: 5px` — inset on purpose, because Studio has many `overflow:hidden` ancestors. Never `ring-*`, never `outline-none`.

---

# F. Proposals for E2-PREP §4 — paste-ready for `CONVENTIONS.md`

Written in the binding voice of §2.4/§2.9/§2.10. Section numbers assume they append to §2.

---

## F.1 — proposed **§2.11 The table density ladder — THREE rows**

> **DECIDED. A table takes a `density` prop, and it is the FIFTH reserved axis (§2.10).**
>
> Why a new axis and not `size`: a table row's scale is not a control's height. §2.10 rule 1 forbids a
> primitive redefining a key, and a `size="md"` table row is 40px while a `size="md"` button is 32px —
> reusing `size` would be exactly the redefinition the rule bans. Why not `variant`: the reference fuses
> density, surface and font-family into one `variant` key, which is the §2.10 failure this system exists
> to prevent. **`density` is scale-of-a-data-grid. It never carries colour, hover behaviour, or font family.**
>
> | `density` | cell | header cell | cell text | header text | fits a control of size |
> |---|---|---|---|---|---|
> | `compact` | `h-7 px-2 align-middle` (28px) | `h-7 px-2` | `text-xs` | `text-xs` | `xs` (h-6) |
> | `default` | `h-10 px-3 align-middle` (40px) | `h-8 px-3` | `text-sm` | `text-xs` | `sm` (28) · `md` (32) |
> | `comfortable` | `h-11 px-4 align-middle` (44px) | `h-9 px-4` | `text-sm` | `text-xs` | `lg` (h-9 = 36) |
>
> - **`default` is the default.** It is `px-3` + a 40px row, which is pixel-identical to what `RunsTable`,
>   `queues.tsx` and `deployments.tsx` ship today — so migrating them is a no-op visually.
> - **The height is `h-*` on the `<td>`, and cells carry NO vertical padding.** `height` on a table cell is a
>   *minimum*: content taller than the row grows it, which is what you want, and it is a single number
>   `estimateSize()` can return for #783. Padding-derived heights are how six screens ended up with six row
>   heights. **A `py-*` on a `<td>` inside `<Table>` is a review failure.**
> - **The fit invariant:** a control of the paired `size` must drop into a cell without changing the row
>   height. That is why the rows are 28/40/44 and not 24/36/40. `/catalog/table` MUST render a row per density
>   with a Button of the paired size in it; if the row grows, the ladder is wrong.
> - **Header text is `text-xs font-medium uppercase tracking-wider text-ink-dimmed` at every density**; only
>   the padding scales. This is a **deliberate divergence** from trigger.dev, whose header is *larger and
>   brighter* than its data (`text-sm text-text-bright` header over `text-xs text-text-dimmed` cells). Four of
>   Studio's six existing tables already use the small-caps dimmed header; the data is the content, the header
>   is the label. Do not re-litigate this per table.
> - **`font-mono` is NOT a density.** The reference's `compact/mono` smuggles a type family into the scale
>   axis. In Studio, monospace is a per-column decision: `className="font-mono tabular-nums"` on the cells that
>   hold ids, durations and counts. `tabular-nums` on every numeric column is mandatory — proportional digits
>   make a column of numbers unreadable.
> - **Surface and hover are NOT a density either.** There is one table surface: header `bg-raised`, body
>   transparent over its container, row hover `bg-hover`, row selected `bg-accent/10`. A table that needs a
>   different surface sets it with `className` on `<Table>`; it does not get a variant.
> - **#862 (E16-T5) is the density toggle and this ladder is its substrate.** It stores the chosen key with the
>   existing `usePersistentState` hook (`src/hooks/usePersistentState.ts`) and passes it straight to
>   `<Table density>`. It MUST NOT introduce its own scale, its own keys, or a fourth row.
> - Adding a fourth row requires adding it here first.

## F.2 — proposed **§2.12 The table row-slot contract**

> **This is E2's equivalent of E1's catalog glob: the one mechanism that makes the parallel wave possible.**
> **#781, #782 and #784 MUST NOT edit `Table.tsx`. If you think you need to, you are wrong — read this section
> again, then escalate.** `Table.tsx` is owned by T1 and by nobody else for the rest of the epic.
>
> **The slot mechanism is composition, not slot props.** The reference proves it works: `TaskRunsTable`
> composes `<TableCell>` + `<Checkbox>` and `<TableCellMenu>` itself, and `Table.tsx` knows nothing about
> selection or actions. Slot props would put three agents back in one file.
>
> ### What T1 (#778) MUST ship, and nothing task-specific
>
> `src/components/primitives/Table.tsx` exports exactly:
>
> ```tsx
> export type TableDensity = "compact" | "default" | "comfortable";
>
> export function Table(props: React.ComponentPropsWithRef<"table"> & {
>   density?: TableDensity;          // default "default"
>   stickyHeader?: boolean;          // default false
>   containerClassName?: string;
> }): JSX.Element;
>
> export function TableHeader(props: React.ComponentPropsWithRef<"thead">): JSX.Element;
>
> export function TableBody<T>(props: Omit<React.ComponentPropsWithRef<"tbody">, "children"> & (
>   | { children: React.ReactNode; rows?: never; renderRow?: never }
>   | { rows: readonly T[]; renderRow: (row: T, index: number) => React.ReactNode; children?: never }
> )): JSX.Element;
>
> export function TableRow(props: React.ComponentPropsWithRef<"tr"> & {
>   isSelected?: boolean;            // sets data-selected="true" + the selected background
>   disabled?: boolean;
> }): JSX.Element;
>
> export function TableHeaderCell(props: React.ComponentPropsWithRef<"th"> & {
>   align?: "left" | "center" | "right";
>   hiddenLabel?: boolean;           // renders children into an sr-only span
>   sortDirection?: "asc" | "desc" | null;   // T2 fills this in; T1 ships the prop + aria-sort
>   onSort?: () => void;
> }): JSX.Element;
>
> export function TableCell(props: React.ComponentPropsWithRef<"td"> & {
>   align?: "left" | "center" | "right";
>   isSticky?: boolean;              // sticky right column: opaque background + z-10
> }): JSX.Element;
>
> export function TableBlankRow(props: React.ComponentPropsWithRef<"tr"> & {
>   colSpan?: number;                // OPTIONAL — see below
> }): JSX.Element;
>
> export function useTableDensity(): TableDensity;   // context read, for slot components
> ```
>
> Five things in that list are load-bearing for the other tickets and MUST be in T1's first PR:
>
> 1. **`<TableCell isSticky>`** — #781's action column needs it.
> 2. **`<TableRow isSelected>`** — #782's row highlight is a prop, not a class the consumer computes.
>    It also sets `data-selected="true"` so tests assert a semantic signal, not a Tailwind string (§8.3).
> 3. **`<TableBlankRow>`** — #784's body slot.
> 4. **`useTableDensity()`** — so a slot component styles itself to the current density without importing
>    internals or receiving a prop drill.
> 5. **`<TableBody rows renderRow>`** — #783's windowing seam (§C.4). T1 renders `rows.map(renderRow)` and
>    nothing more; T6 replaces that one expression.
>
> **`colSpan` is optional and defaults to `1000`.** HTML clamps a `colspan` to the table's actual column count,
> so a blank row always spans the full width with no hand-counting. The reference hand-counts
> `colSpan={showRegion ? 16 : 15}` in four places in one file; that is a defect waiting to happen. **This
> behaviour is not observable in jsdom — T1 MUST verify it in a real browser and quote the measurement.**
>
> ### What the slot consumers own — new files only
>
> | ticket | new files | how it plugs in |
> |---|---|---|
> | **#781 row actions** | `primitives/TableRowActions.tsx` | exports `<TableRowActions items={DropdownMenuEntry[]} label=…>`; renders `<TableCell isSticky align="right">` + `SimpleDropdownMenu`. Zero edits to `Table.tsx`. |
> | **#782 selection** | `primitives/useTableSelection.ts`, `primitives/TableSelectCell.tsx`, `primitives/BulkActionBar.tsx` | the cell renders `<TableCell><Checkbox …/></TableCell>`; the row highlight is `<TableRow isSelected>`, already supported. Zero edits. |
> | **#784 blank states** | `primitives/TableBlankState.tsx` | exports `<TableEmpty>` and `<TableNoResults>`, both rendering `<TableBlankRow>` + the **existing** `EmptyState` primitive. Zero edits. |
>
> **Forbidden-file list handed to Wave B verbatim:** `primitives/Table.tsx`, `app.css`, `package.json`,
> `vite.config.ts`, `vitest.config.ts`, anything in `src/__tests__/`, `routeTree.gen.ts`, and each other's files.
>
> ### Empty vs no-results — who owns what (E2-PREP §4.5)
>
> **E2 owns the table-shaped presentation; E11 owns the content.** `#784` ships `TableBlankState.tsx`, which is
> a thin wrapper putting an `EmptyState` inside a `TableBlankRow`. It MUST NOT create a second empty-state
> component, must not restyle `EmptyState`, and must not invent copy. **E11-T4 (#839)** later swaps the
> `EmptyState` content and doc links with zero changes to E2's files. The three states, named once so nobody
> invents a fourth:
> `empty` (nothing has ever been here) · `no-results` (filters excluded everything) · `loading`
> (an overlay row; `<TableBody>` is `relative` so it can be positioned).
>
> **The blank row lives INSIDE `<TableBody>`, not beside the table.** Studio's callers branch outside today
> (`runs.length > 0 ? <RunsTable/> : <EmptyState/>`), which throws away the header, the column widths and the
> sticky behaviour and makes the page jump. Inside is the reference's choice and it is right.

## F.3 — proposed **§2.13 Selection-state ownership**

> **DECIDED: a hook, owned by the caller. No context, no table-owned state.**
>
> ```tsx
> // src/components/primitives/useTableSelection.ts  — #782 owns this file
> export function useTableSelection(
>   ids: readonly string[],          // every id currently on the page, in visual order
>   options?: { max?: number },
> ): {
>   selected: ReadonlySet<string>;
>   has: (id: string) => boolean;
>   toggle: (id: string) => void;
>   selectRange: (fromId: string, toId: string) => void;  // shift-click / shift-arrow
>   selectAll: () => void;
>   clear: () => void;
>   allSelected: boolean;
>   someSelected: boolean;           // → the header checkbox's `indeterminate`
> };
> ```
>
> **`<Table>` never owns selection. `<TableRow isSelected>` is a pure presentational prop.**
>
> Reasoning:
> - Studio's `BulkActionToolbar` already takes `selectedIds` as a prop and renders as a **sibling** of the
>   table (`RunsTable.tsx:274`). The caller already holds the state; a context provider would add a wrapper
>   whose only consumers are already its children. Ponytail rung 2.
> - The reference uses a context (`SelectedItemsProvider`) only because its bulk UI is a **resizable side
>   panel two components away**, and it pays for it with `useSelectedItems(enabled)` returning `{}` cast to
>   the context type when disabled — an `any` in all but name, which this repo forbids.
> - One model, so #780's keyboard nav and #782's bulk bar cannot diverge: **the hook is the model.**
> - `selectRange` lives in the hook because it is the one operation the caller cannot do trivially — it needs
>   the ordered `ids` array the hook already closed over. **Do not hand-roll the reference's
>   `navigateCheckboxes` ref-array; it has an acknowledged off-by-one and a wrong dep array.**
> - `max` caps the set. Unlike the reference, exceeding it MUST be a no-op with a visible message, not a
>   `console.warn` + silent truncation.
>
> If a future screen needs the selection three levels away, it lifts the hook and wraps it in a context **at
> that call site**. That is not a reason to ship a context now.

## F.4 — proposed **§2.14 Table accessibility baseline — MUST rules**

> Every rule below is a MUST. §9 still applies on top of this.
>
> 1. **Real `<table>` semantics. Never `role="grid"`, never a div-table.** `<table>/<thead>/<tbody>/<tr>/<th scope="col">/<td>`.
>    `role="grid"` obliges full two-dimensional cell navigation with a roving tabindex and `aria-colindex`
>    — a far bigger contract than #780 asks for. **The moment E2 is allowed to reach for `grid` is the moment a
>    screen needs cell-level selection without checkboxes; that is a new ticket, not an improvisation.**
> 2. **Focus lives on ONE interactive element per row. The `<tr>` is never `tabIndex={0}`.**
>    The row's primary link/button carries `tabIndex={0}`; every other link inside the row carries
>    `tabIndex={-1}`. One Tab stop per row. Row-level ↑/↓ (#780) moves focus **between those primary
>    elements** and is a progressive enhancement on top of Tab, never the only path.
> 3. **The row hover/focus background is on the `<tr>`**, driven by `:hover` and `:focus-within`, and the
>    focus *ring* is `.focus-ring` on the focused element (§2.7). Never `:focus` for the visual row highlight —
>    use `:focus-visible`, or a mouse click paints a focus state (the reference's bug).
> 4. **`aria-sort` on every sortable `<th>`**, `ascending`/`descending`/`none`. **At most one column may be
>    non-`none`.** Non-sortable headers set nothing.
> 5. **The sort control's accessible name names the column.** `Sort by Duration`, not `Toggle sort`. **The
>    whole header content is the button**, not just the chevron — a chevron-only target is under WCAG 2.2 AA
>    2.5.8's 24×24px minimum.
> 6. **Selection is conveyed by real checkboxes and NOT by `aria-selected`.** `data-selected="true"` is the
>    styling and testing hook. Every row checkbox has an accessible name that identifies the row
>    (`label={<span className="sr-only">Select run {id}</span>}`); the header checkbox is
>    `Select all {n} rows` and sets the DOM `indeterminate` property when partially selected (§G.3).
> 7. **Row-action triggers are keyboard reachable at all times.** Reveal-on-hover MUST also reveal on
>    `group-focus-within`, or be implemented with `opacity` rather than `display:none`. `display:none` removes
>    the control from the tab order — that is the reference's bug and it fails §9.
> 8. **`aria-rowcount`/`aria-rowindex` are set if and ONLY if the DOM does not hold every row** — i.e. under
>    virtualization. Then: `aria-rowcount` on the `<table>` = data rows **+ 1 for the header**;
>    `aria-rowindex` on each rendered `<tr>` = its absolute 0-based data index **+ 2** (the header row is
>    index 1); the windowing spacer rows carry `aria-hidden="true"` and no index. Non-virtualized and
>    server-paginated tables set **neither** — the DOM is already the truth.
> 9. **Sticky headers keep a solid background token** (`bg-raised`), never a translucent one, and draw their
>    bottom hairline as an `after:` pseudo-element, never `border-b` — under `border-collapse: collapse`
>    (Tailwind Preflight's default) a border on a sticky `<thead>` does not travel with it.
> 10. **Z-index is fixed and small:** sticky header `z-20` · sticky right column `z-10` · everything else
>    unset. Radix portals stay at `z-50` (§4.3). The header must win where they cross, top-right.
> 11. **Every icon-only row action carries an `aria-label` that names both the action and the row.**
>
> ### Sort/filter URL state (E2-PREP §4.6, and #789 in E3)
>
> **Sort state belongs in the URL, with the filters, and E3 owns the wiring.** Therefore **#779's sort MUST be
> controllable**: `<TableHeaderCell sortDirection onSort>` stays purely presentational, and #779 ships
> `useTableSort(rows, columns)` as the *default local* owner. E3 later replaces the hook's state with URL
> state at the call site, touching no E2 file. Copy the reference's semantics: three-state cycle
> `asc → desc → cleared`, stable sort, nulls last in both directions, `localeCompare` with
> `sensitivity: "base"` for text; and keep the comparator exported as a pure function so it is unit-testable
> without rendering.

---

# G. Traps — the things that will bite

### G.1 The frozen catalog test renders pages BARE, and the E1 workaround is in the wrong place

`src/__tests__/catalog.test.tsx` (frozen, do not open):

```tsx
it.each(catalogPages.map((p) => [p.slug, p] as const))("%s renders with a heading", async (_slug, page) => {
  const mod = await page.load();
  expect(mod.default).toBeTypeOf("function");
  render(<mod.default />);
  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
});
```

No `RouterProvider`. A TanStack `<Link>` inside a `/catalog/table` row demo **crashes the whole suite**.
E1's workaround lives in the *catalog page*:

```tsx
// src/catalog/buttons.tsx:15
const hasRouter = Boolean(useRouter({ warn: false }));
```
…and the page then conditionally renders the `LinkButton` section. That is the wrong place: it makes every future page author repeat it, and it silently drops a section from the catalog.

**[REC] The proper fix, and it is already shipped elsewhere in the repo:** put the router-absence fallback **inside the primitive**, exactly as `primitives/TextLink.tsx` does:

```tsx
// src/components/primitives/TextLink.tsx:45
const router: unknown = useRouter({ warn: false });
if (external || !router) { return <a href={href} …>{children}</a>; }
return <Link to={href as never} …>{children}</Link>;
```

Concretely for E2:
- **`Table.tsx` MUST NOT import `@tanstack/react-router` at all.** Unlike the reference, `TableCell` takes no `to` prop. Row navigation is the caller's: it wraps cell content in whatever link it wants.
- If a `TableRowLink` convenience is wanted, it lives in its own file and reuses `TextLink`'s degradation pattern (render `<a href>` when `useRouter({ warn: false })` returns undefined).
- Result: `src/catalog/table.tsx` needs no `hasRouter` gate and shows every variant unconditionally.
- Report this upward as a CONVENTIONS §7 amendment: **"a primitive that needs the router degrades to `<a>` itself; catalog pages never gate on router presence."**

### G.2 The single-`<h1>` rule cuts both ways

`getByRole("heading", { level: 1 })` throws on **multiple** matches as well as on zero. `CatalogPage` already renders the page's one `<h1>`. `EmptyState` renders an `<h3>` — safe. Do not let a table demo or a blank-state demo add a second `<h1>`.

### G.3 `indeterminate` is a DOM property, not a JSX attribute

The header select-all checkbox must show a partial state. React does **not** support `indeterminate` as a prop. `primitives/Checkbox.tsx` spreads `...props` onto the real `<input>` and its type is `ComponentPropsWithRef<"input">`, so the ref is available:

```tsx
<Checkbox
  checked={allSelected}
  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
  label={<span className="sr-only">Select all {ids.length} rows</span>}
  onChange={…}
/>
```
A ref callback that runs on every render is fine here; a `useEffect` is also fine. Passing `indeterminate={…}` is not — React 19 will forward it as an unknown attribute and it will do nothing.

### G.4 Tailwind v4 folds `outline-color` into `transition-colors` — the E1 defect, re-armed

E1 shipped a focus ring that faded in from each element's own text colour because `transition-colors` includes `outline-color` in v4. A hovered table row is exactly the element that wants a colour transition **and** carries `.focus-ring`. **Use `transition-[color,background-color]`, never bare `transition-colors`, on `<tr>` and `<td>`** — this is what `CopyButton.tsx` and `CopyableText.tsx` already do.

### G.5 jsdom cannot see anything that matters about a table

`vitest.config.ts` → `environment: "jsdom"`, and `src/__tests__/setup.ts` contains only a `localStorage` polyfill — **no `ResizeObserver`, no `IntersectionObserver`, no layout**.

Unverifiable in jsdom, therefore **MUST be measured in a real browser** (`.claude/launch.json` entry `blok-studio`, port 5599) with `getBoundingClientRect()` / `getComputedStyle()` / real `Tab` and arrow keypresses, and the measurement quoted in the PR:

- `position: sticky` actually sticking (jsdom computes no scroll)
- the density ladder's real row heights, and the fit invariant (a `sm` Button in a `default` row)
- `h-*` on a `<td>` behaving as a **minimum** height
- `colSpan={1000}` clamping to the real column count (§F.2)
- the sticky header hairline surviving `border-collapse: collapse`
- z-index ordering where the sticky header and the sticky right column cross
- `<tr>` background painting underneath a sticky cell (§A.7's simplification)
- anything the virtualizer measures — `@tanstack/react-virtual` uses `ResizeObserver`, which does not exist in jsdom, so **a virtualized table renders zero rows in a jsdom test**. Mirror `StepRail.tsx`'s `count: useVirtual ? n : 0` gate so tests below the threshold take the plain path and need no polyfill.

### G.6 The `<tr>`-background simplification is a claim, not a fact, until measured

§A.7 argues Blok can delete ~450 characters of per-cell hover patching by putting the background on the `<tr>`. Two things could invalidate it: the sticky right cell needs its own opaque background regardless (it does), and a `<td>` with its own background will occlude the row's. Verify with `getComputedStyle` on a hovered row, both with and without a sticky column, before writing the rule into `CONVENTIONS.md`.

### G.7 React 19 — strip every `forwardRef` you paste

The reference's ten table exports are all `forwardRef`. CONVENTIONS §2.8: Studio is React 19 (19.2.8 installed), `forwardRef` is deprecated, declare `ref` as a plain prop via `React.ComponentPropsWithRef<"td">`. The single exception is inside a Radix wrapper file — `Table.tsx` is not one.

### G.8 Dependencies — nothing to add, and one to remove later

`@tanstack/react-virtual@^3.11.0` and `@tanstack/react-table@^8.20.0` are **already** in `apps/studio/package.json`. T6 adds no dependency. `react-table` has exactly one consumer (`RunsTable.tsx`); once E2 replaces it the dependency is removable — but **not during a parallel wave**: `package.json` edits are a guaranteed conflict. Do it in the reconcile PR, or file it as a follow-up.

### G.9 Mechanics that cost time in E1 and will again

- Agent worktrees have no `node_modules` → **`bun install` first, always.**
- Biome: **tabs, `lineWidth: 120`**; the reference is 2-space/100, so every pasted line fails `bun run lint` until reformatted. Biome also forbids `delete obj.prop`.
- Never hand-edit `src/routeTree.gen.ts`. `src/catalog/` sits outside `src/routes/` precisely so the generator never sees it.
- `bun run ci:fast` is the orchestrator's job; agents run targeted suites (`bun run --filter @blokjs/studio test`).
- `src/catalog/table.tsx` is the free slug — taken so far: `buttons`, `clipboard`, `feedback`, `forms`, `foundation`, `overlays`, `tooltips`, `typography`.
- The token guard (`src/__tests__/tokens.test.ts`) scans `components/primitives/`, `components/catalog/` and `src/catalog/`. Every reference token you paste (`text-text-bright`, `bg-background-dimmed`, `border-grid-bright`, `focus-custom`) **fails the build and renders nothing**. The variant table in §A.2 is the single densest source of them in the whole reference — retype it, do not paste it.
- E2-PREP §2.1: prove every fix fails without itself (mutate, run, restore) and quote the failure. A reviewer must attempt the revert, not read the diff.

### G.10 Migration shape for `RunsTable` — decide before Wave A ends

`RunsTable`'s two call sites pass 8 props and both branch on `runs.length > 0` outside the component. **[REC]** Do not migrate call sites during the wave (CONVENTIONS §6 exists for this reason). Instead, after Wave C, a single PR rewrites `RunsTable.tsx`'s **internals** onto the new primitives while keeping its exported name and prop signature byte-identical (§6.0's shim contract), and moves the empty-state branch inside it. The two routes then change zero lines. That also retires `@tanstack/react-table` in the same diff.

---

## H. The three decisions the founder must make before Wave A starts

1. **Virtualization (E2-PREP §6's open checkbox).** Recommended: **seam in T1, threshold-gated windowing in T6**, and seriously consider **deferring T6's implementation** — every Studio table is paginated today, the reference does not virtualize tables at all, and the only genuinely unbounded list in Studio is the log stream. The seam is cheap; the implementation may be premature.
2. **A fifth prop axis.** §F.1 proposes `density` as a new reserved axis in §2.10 rather than overloading `size`. That is an amendment to the E1 contract and needs a yes.
3. **Blank state moves inside the table.** §F.2 puts `TableBlankRow` inside `<TableBody>`, which changes how callers branch. Confirm E2 may own that change (via the §G.10 shim, so no route file is touched).

Everything else in §F is prescriptive and needs no decision — hand it to the agents verbatim.
