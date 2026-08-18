import { Button } from "@/components/primitives/Buttons";
import { Text } from "@/components/primitives/Text";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The bar that appears when a table selection is non-empty: a live count, the
 * caller's actions, and Clear.
 *
 * There is NO reference implementation for this — trigger.dev has no bulk-action
 * bar at all (selection there drives a count `Badge` plus a resizable side
 * panel). Blok's own `components/runs/BulkActionToolbar.tsx` is what this
 * generalises: it renders above the table rather than floating over it, because
 * operators objected to chrome that occludes the data, and it now composes this
 * primitive for its chrome while keeping its run-specific actions
 * (`_design/CONVENTIONS.md` §2.14).
 *
 * Presentational and stateless. Selection state is the caller's
 * `useTableSelection` (§2.14) — this component never owns a set.
 */
export function BulkActionBar({
	count,
	onClear,
	children,
	note,
	atMax = false,
	max,
	className,
}: {
	/** Selected row count. At 0 the bar renders nothing. */
	count: number;
	onClear: () => void;
	/** The actions. Right-aligned, before Clear. */
	children?: ReactNode;
	/** Left-aligned context next to the count ("2 non-HTTP, replay-skip"). */
	note?: ReactNode;
	/** The selection cap is reached. §2.14: a VISIBLE message, never a console.warn. */
	atMax?: boolean;
	max?: number;
	className?: string;
}) {
	if (count === 0) return null;

	return (
		// A named `<section>`, not `role="group"` on a div: the element carries the
		// semantics natively (biome's useSemanticElements enforces that, and §9
		// forbids suppressing it). `role="toolbar"` would promise the APG's
		// roving-tabindex arrow-key model, which this bar does not implement — its
		// buttons are ordinary tab stops, like every other control in a row (§2.15
		// rule 3).
		<section
			aria-label="Bulk actions"
			className={cn(
				"flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-raised px-3 py-2",
				className,
			)}
		>
			{/*
			 * Polite, not assertive: the count changes on every click and an assertive
			 * region would interrupt the user mid-word. `numeric` keeps the digits from
			 * reflowing the row as the count crosses 9 → 10.
			 */}
			<p aria-live="polite" className="text-sm text-ink">
				<Text numeric ink="strong" className="font-medium">
					{count}
				</Text>{" "}
				selected
			</p>
			{note && <div className="text-xs text-ink-dimmed">{note}</div>}
			{atMax && (
				<p className="text-xs text-ink-dimmed">
					{max === undefined ? "Selection limit reached" : `Selection limit of ${max} reached`} — deselect a row to pick
					another.
				</p>
			)}

			<div className="ml-auto flex flex-wrap items-center gap-2">
				{children}
				<Button variant="minimal" size="sm" onClick={onClear} leadingIcon={<X />}>
					Clear
				</Button>
			</div>
		</section>
	);
}
