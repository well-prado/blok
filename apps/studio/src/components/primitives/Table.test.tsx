import {
	TABLE_DENSITY_CLASSES,
	TABLE_ROW_HEIGHT,
	Table,
	TableBlankRow,
	TableBody,
	TableCell,
	TableHeader,
	TableHeaderCell,
	TableRow,
	useTableDensity,
} from "@/components/primitives/Table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Table", () => {
	it("renders a named table with its header and rows", () => {
		render(
			<Table aria-label="Recent runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell>Run</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>run_01H8Z3K9</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		// §2.15 rule 2: a table with no accessible name is announced as "table".
		expect(screen.getByRole("table", { name: "Recent runs" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Run" })).toBeInTheDocument();
		expect(screen.getByRole("cell", { name: "run_01H8Z3K9" })).toBeInTheDocument();
	});

	it("marks a selected row with data-selected, not aria-selected", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow isSelected>
						<TableCell>picked</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const row = screen.getByRole("row");
		// §2.15 rule 6 / §8.3: a semantic signal, not a Tailwind class string.
		expect(row).toHaveAttribute("data-selected", "true");
		expect(row).not.toHaveAttribute("aria-selected");
	});

	it("makes a sortable header a real button named for its column", async () => {
		const onSort = vi.fn();
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell sortDirection="asc" onSort={onSort}>
							Duration
						</TableHeaderCell>
						<TableHeaderCell>Status</TableHeaderCell>
					</TableRow>
				</TableHeader>
			</Table>,
		);
		expect(screen.getByRole("columnheader", { name: /Duration/ })).toHaveAttribute("aria-sort", "ascending");
		// A non-sortable header sets nothing at all (§2.15 rule 4).
		expect(screen.getByRole("columnheader", { name: "Status" })).not.toHaveAttribute("aria-sort");
		// The accessible name is the COLUMN plus what the NEXT press does — never
		// "Toggle sort", and never a bare column name that leaves a screen-reader
		// user guessing which way the arrow is about to go (§2.15 rule 5, E2-T2).
		// It is an `sr-only` span, not an `aria-label`, so the name still contains
		// its own visible label (WCAG 2.5.3).
		const button = screen.getByRole("button", { name: "Duration, sort descending" });
		expect(button).not.toHaveAttribute("aria-label");
		// The UA stylesheet's `text-transform: none` on `button` beats the `<th>`'s
		// inherited `uppercase`, so the class is repeated on the button or a
		// sortable column renders in title case beside uppercase siblings (§2.11).
		// Measured live; jsdom computes no UA text-transform, so the class string
		// is the only guard available (§8.3 point 2).
		expect(button).toHaveClass("uppercase");
		await userEvent.click(button);
		expect(onSort).toHaveBeenCalledOnce();
	});

	it("renders rows through the virtualization seam, and only when both halves are given", () => {
		const renderRow = vi.fn((row: { id: string }) => (
			<TableRow key={row.id}>
				<TableCell>{row.id}</TableCell>
			</TableRow>
		));
		const { rerender } = render(
			<Table aria-label="Runs">
				<TableBody rows={[{ id: "a" }, { id: "b" }]} renderRow={renderRow} />
			</Table>,
		);
		expect(screen.getAllByRole("row")).toHaveLength(2);
		expect(renderRow).toHaveBeenCalledTimes(2);

		renderRow.mockClear();
		rerender(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>literal child</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(renderRow).not.toHaveBeenCalled();
		expect(screen.getAllByRole("row")).toHaveLength(1);
	});

	it("spans a blank row across the whole table without hand-counting columns", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableBlankRow>nothing here yet</TableBlankRow>
				</TableBody>
			</Table>,
		);
		// 1000 is HTML's clamp; surplus columns are zero-width (§2.13).
		expect(screen.getByRole("cell", { name: "nothing here yet" })).toHaveAttribute("colspan", "1000");
	});

	it("exposes density through context rather than a prop drill", () => {
		function Probe() {
			return <TableCell>{useTableDensity()}</TableCell>;
		}
		render(
			<Table aria-label="Runs" density="compact">
				<TableBody>
					<TableRow>
						<Probe />
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
		expect(screen.getByRole("cell", { name: "compact" })).toBeInTheDocument();
	});

	/**
	 * Everything below this line is a SEAM GUARD, not a style test. Each behaviour
	 * here is depended on by a task that is forbidden from editing `Table.tsx`
	 * (§12.5), so if one is deleted there is nobody downstream who can notice.
	 * Every one of these was proven to fail on its own revert.
	 *
	 * §8.3 point 2 sanctions `toHaveClass` on ONE discriminating utility where
	 * nothing semantic distinguishes the states — which is the case for every
	 * paint-level seam here.
	 */

	it("sticks the header to the scroll container only when asked (§2.12 rules 6-8)", () => {
		function Fixture({ sticky }: { sticky: boolean }) {
			return (
				<Table aria-label="Runs" stickyHeader={sticky}>
					<TableHeader data-testid="head">
						<TableRow>
							<TableHeaderCell>Run</TableHeaderCell>
						</TableRow>
					</TableHeader>
				</Table>
			);
		}
		const { rerender } = render(<Fixture sticky={false} />);
		expect(screen.getByTestId("head")).not.toHaveClass("sticky");

		rerender(<Fixture sticky />);
		const head = screen.getByTestId("head");
		// `top-0` and `z-20` are the position; the `after:` hairline is the part
		// `border-b` cannot do under `border-collapse: collapse` (§2.12 rule 8).
		expect(head).toHaveClass("sticky", "top-0", "z-20", "after:bg-line");
	});

	it("ships group/row, an opaque base background and the row separator on DATA rows (§2.12)", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>run_01H8Z3K9</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const row = screen.getByRole("row");
		// `group/row` is the hook E2-T4's action trigger hangs `group-hover/row:`
		// off (§2.15 rule 7) and it can only be added here.
		// `bg-raised` is what makes a sticky cell's `bg-inherit` resolve to an
		// opaque color (§2.12 rules 2-3), and the separator is the row's, not the
		// cell's.
		expect(row).toHaveClass("group/row", "bg-raised", "border-b", "last:border-b-0");
	});

	it("does NOT make the header row hover or act as a group (the header is not a data row)", () => {
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell>Run</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>run_01H8Z3K9</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const [headerRow, dataRow] = screen.getAllByRole("row");
		// Measured live before this fix: the header lit up 17,17,19 → 31,31,35 on a
		// real mouse hover, and a `group-hover/row:` reveal would fire from the
		// header — where E2-T5's select-all cell lives.
		expect(headerRow).not.toHaveClass("group/row");
		expect(headerRow).not.toHaveClass("hover:bg-hover");
		expect(dataRow).toHaveClass("group/row", "hover:bg-hover");
	});

	it("paints hover and selection on the row, selection winning (§2.12 rules 1, 4, 5)", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>plain</TableCell>
					</TableRow>
					<TableRow isSelected>
						<TableCell>picked</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const [plain, picked] = screen.getAllByRole("row");
		expect(plain).toHaveClass("hover:bg-hover");
		// Opaque token, and NOT stacked with a hover variant: equal specificity
		// would leave the winner up to Tailwind's emission order.
		expect(picked).toHaveClass("bg-control");
		expect(picked).not.toHaveClass("hover:bg-hover");
	});

	it("gives a sticky cell bg-inherit so it tracks the row's own state (§2.12 rule 3)", () => {
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>scrolls</TableCell>
						<TableCell isSticky>pinned</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		// Its own token would occlude the row state; no background at all lets
		// scrolled content pass through it. Verified in a browser (§2.18).
		expect(screen.getByRole("cell", { name: "pinned" })).toHaveClass("sticky", "right-0", "z-10", "bg-inherit");
		expect(screen.getByRole("cell", { name: "scrolls" })).not.toHaveClass("bg-inherit");
	});

	it("hides a hiddenLabel header's text visually while keeping it named and unselectable", () => {
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
					</TableRow>
				</TableHeader>
			</Table>,
		);
		// The name survives (that is the point of the prop) …
		const header = screen.getByRole("columnheader", { name: "Actions" });
		// … in an `sr-only` span that also carries `select-none`, or a mouse-drag
		// over the column copies the invisible string too (§2.12 rule 11).
		const label = header.querySelector("span");
		expect(label).toHaveClass("sr-only", "select-none");
		expect(label).toHaveTextContent("Actions");
	});

	it("aligns cells and header cells through the align prop", () => {
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell align="right">Duration</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell align="right">1.24s</TableCell>
						<TableCell>run_01H8Z3K9</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(screen.getByRole("columnheader", { name: "Duration" })).toHaveClass("text-right");
		expect(screen.getByRole("cell", { name: "1.24s" })).toHaveClass("text-right");
		// The default is left, not "unset" — a numeric column that forgets `align`
		// must not silently inherit whatever the last cell did.
		expect(screen.getByRole("cell", { name: "run_01H8Z3K9" })).toHaveClass("text-left");
	});

	it("has no disabled prop, and a row's controls stay operable (§2.6)", async () => {
		const onClick = vi.fn();
		render(
			<Table aria-label="Runs">
				<TableBody>
					{/*
					 * The guard for a DELETED prop. `disabled` on a row rendered
					 * `aria-disabled` + `opacity-50` + `pointer-events-none`: announced as
					 * unavailable, still tabbable, still fired on Enter. Re-adding it makes
					 * this directive unused, and `tsc -b` (run by `bun run build`) fails
					 * with "Unused '@ts-expect-error' directive".
					 */}
					{/* @ts-expect-error — TableRow has no `disabled` prop, deliberately. */}
					<TableRow disabled>
						<TableCell>
							<button type="button" onClick={onClick}>
								Replay
							</button>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const row = screen.getByRole("row");
		expect(row).not.toHaveAttribute("aria-disabled");
		expect(row).not.toHaveClass("opacity-50");
		// Nothing half-disables the button, so nothing lies about it.
		await userEvent.tab();
		expect(screen.getByRole("button", { name: "Replay" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("forwards the aria attributes windowing will need (§2.15 rule 8, §2.16 rule 5)", () => {
		// E2-T6 turns `aria-rowcount` on at the `<table>` and `aria-rowindex` on
		// each rendered row; both ride the prop spread rather than a dedicated prop.
		// If either spread is dropped, windowing silently ships wrong row counts.
		render(
			<Table aria-label="Runs" aria-rowcount={501}>
				<TableBody>
					<TableRow aria-rowindex={42}>
						<TableCell>run_01H8Z3K9</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "501");
		expect(screen.getByRole("row")).toHaveAttribute("aria-rowindex", "42");
	});

	/**
	 * E2-T3 (issue 780) — row hover / focus / keyboard navigation.
	 *
	 * The paint is two class assertions (§8.3 point 2 — jsdom has no `:hover`, no
	 * `:focus-visible` and no layout, and the live measurements are in §2.18).
	 * Everything else here is real behaviour: jsdom DOES have focus and key
	 * events, so the navigation itself is guarded properly rather than by class.
	 */
	function NavFixture({ onKeyDown }: { onKeyDown?: React.KeyboardEventHandler<HTMLTableSectionElement> } = {}) {
		return (
			<Table aria-label="Runs">
				<TableBody onKeyDown={onKeyDown}>
					<TableRow>
						<TableCell>
							<a href="/runs/k9">run_01H8Z3K9</a>
						</TableCell>
						<TableCell>
							<button type="button">Replay K9</button>
						</TableCell>
					</TableRow>
					{/* A blank row — E2-T7's empty state and E2-T6's spacer rows look like
					    this. Arrow navigation must step OVER it, not stop at it. */}
					<TableBlankRow>nothing focusable here</TableBlankRow>
					<TableRow>
						<TableCell>
							{/* A redundant second link to the same record: `tabIndex={-1}` per
							    §2.15 rule 3, so it is neither a tab stop nor an arrow target. */}
							<a href="/runs/m2" tabIndex={-1}>
								status chip M2
							</a>
						</TableCell>
						<TableCell>
							<a href="/runs/m2">run_01H8Z3M2</a>
						</TableCell>
					</TableRow>
					<TableRow>
						<TableCell>
							{/* An ordinary earlier link that is NOT the record's primary one —
							    the case `data-row-primary` exists for. */}
							<a href="/workflows/process-order">process-order</a>
						</TableCell>
						<TableCell>
							<a href="/runs/p7" data-row-primary>
								run_01H8Z3P7
							</a>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
	}

	it("moves focus between rows on ArrowDown / ArrowUp, skipping rows with nothing to focus", async () => {
		const user = userEvent.setup();
		render(<NavFixture />);
		screen.getByRole("link", { name: "run_01H8Z3K9" }).focus();

		await user.keyboard("{ArrowDown}");
		// Skipped the blank row entirely, and skipped the redundant `tabIndex={-1}`
		// chip that precedes the row's real link (§2.15 rule 3).
		expect(screen.getByRole("link", { name: "run_01H8Z3M2" })).toHaveFocus();

		await user.keyboard("{ArrowDown}");
		// `data-row-primary` beats DOM order: the workflow link comes first in the
		// row and is not what the row is about.
		expect(screen.getByRole("link", { name: "run_01H8Z3P7" })).toHaveFocus();

		await user.keyboard("{ArrowUp}{ArrowUp}");
		expect(screen.getByRole("link", { name: "run_01H8Z3K9" })).toHaveFocus();
	});

	it("navigates a row whose only affordance is a button, and never a disabled one", async () => {
		const user = userEvent.setup();
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>
							<button type="button">Replay K9</button>
						</TableCell>
					</TableRow>
					<TableRow>
						<TableCell>
							<button type="button" disabled>
								Replay M2
							</button>
						</TableCell>
					</TableRow>
					<TableRow>
						<TableCell>
							<button type="button">Replay P7</button>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		screen.getByRole("button", { name: "Replay K9" }).focus();
		await user.keyboard("{ArrowDown}");
		// A row whose controls are all disabled has no destination — §2.13's
		// "disable the CONTROLS, never the row" is what a keyboard user then meets.
		expect(screen.getByRole("button", { name: "Replay P7" })).toHaveFocus();
	});

	it("is a progressive enhancement on Tab, not a roving tabindex (§2.15 rule 3)", async () => {
		const user = userEvent.setup();
		render(<NavFixture />);
		screen.getByRole("link", { name: "run_01H8Z3K9" }).focus();
		await user.keyboard("{ArrowDown}");

		// No `<tr>` is focusable and no control's tabIndex was rewritten, so every
		// action in every row keeps its ordinary tab stop — which is what lets
		// E2-T4's `focus-visible:` reveal fire at all (§2.15 rule 7).
		for (const row of screen.getAllByRole("row")) expect(row).not.toHaveAttribute("tabindex");
		expect(screen.getByRole("button", { name: "Replay K9" })).not.toHaveAttribute("tabindex");
		// Tab still walks the row's own controls, in DOM order.
		screen.getByRole("link", { name: "run_01H8Z3K9" }).focus();
		await user.tab();
		expect(screen.getByRole("button", { name: "Replay K9" })).toHaveFocus();
	});

	it("ignores an arrow that came from a nested table's own rows", async () => {
		const user = userEvent.setup();
		render(
			<Table aria-label="Runs">
				<TableBody>
					<TableRow>
						<TableCell>
							<a href="/runs/k9">run_01H8Z3K9</a>
						</TableCell>
					</TableRow>
					<TableRow>
						<TableCell>
							<Table aria-label="Steps">
								<TableBody>
									<TableRow>
										<TableCell>
											<a href="/steps/1">step 1</a>
										</TableCell>
									</TableRow>
								</TableBody>
							</Table>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		screen.getByRole("link", { name: "step 1" }).focus();
		// The inner body handles its own rows; the event then bubbles to the outer
		// one, which must recognise the row as none of its children. Without that
		// check the outer table reads an index of -1 and jumps to its first row.
		await user.keyboard("{ArrowDown}");
		expect(screen.getByRole("link", { name: "step 1" })).toHaveFocus();
	});

	it("does not trap or wrap at either end, and leaves the arrow key alone there", async () => {
		const user = userEvent.setup();
		const onTableKeyDown = vi.fn();
		render(
			<Table aria-label="Runs" onKeyDown={onTableKeyDown}>
				<TableBody>
					<TableRow>
						<TableCell>
							<a href="/runs/k9">run_01H8Z3K9</a>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const only = screen.getByRole("link", { name: "run_01H8Z3K9" });
		only.focus();

		await user.keyboard("{ArrowUp}{ArrowDown}");
		expect(only).toHaveFocus();
		// And the page still scrolls: a boundary press is NOT swallowed, which a
		// handler that called preventDefault() up front would have done.
		expect(onTableKeyDown).toHaveBeenCalledTimes(2);
		for (const [event] of onTableKeyDown.mock.calls) expect(event.defaultPrevented).toBe(false);
	});

	it("leaves the arrow keys to a control that owns them, and runs the caller's handler", async () => {
		const user = userEvent.setup();
		const onKeyDown = vi.fn();
		render(
			<Table aria-label="Runs">
				<TableBody onKeyDown={onKeyDown}>
					<TableRow>
						<TableCell>
							<input aria-label="Rename run" defaultValue="run_01H8Z3K9" />
						</TableCell>
					</TableRow>
					<TableRow>
						<TableCell>
							<a href="/runs/m2">run_01H8Z3M2</a>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const field = screen.getByRole("textbox", { name: "Rename run" });
		field.focus();

		await user.keyboard("{ArrowDown}");
		// The caret belongs to the field; stealing it is how a table breaks inline
		// editing. A checkbox is deliberately NOT in that exemption, so E2-T5's
		// selection column still navigates.
		expect(field).toHaveFocus();
		// The caller's own handler still sees every key, ours or not.
		expect(onKeyDown).toHaveBeenCalledOnce();
	});

	it("paints the keyboard-focused row like the hovered one, and never the header row (§2.15 rule 9)", () => {
		render(
			<Table aria-label="Runs">
				<TableHeader>
					<TableRow>
						<TableHeaderCell>Run</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>plain</TableCell>
					</TableRow>
					<TableRow isSelected>
						<TableCell>picked</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		const [headerRow, plain, picked] = screen.getAllByRole("row");
		// `:focus-visible`, never `:focus-within` — the reference keys off `:focus`
		// and so paints a keyboard state on a mouse click.
		expect(plain).toHaveClass("has-[:focus-visible]:bg-hover");
		expect(headerRow).not.toHaveClass("has-[:focus-visible]:bg-hover");
		// Selection is the stronger signal and stays unmoved, exactly as with hover.
		expect(picked).toHaveClass("bg-control");
		expect(picked).not.toHaveClass("has-[:focus-visible]:bg-hover");
	});

	// The one non-trivial invariant in this file. E2-T6 reads TABLE_ROW_HEIGHT for
	// `estimateSize` and E16-T5 may read it too, so the number and the class it is
	// supposed to describe must not drift apart. Edit either alone and this fails.
	it("keeps TABLE_ROW_HEIGHT and the density class table in lockstep (§2.11)", () => {
		for (const [density, height] of Object.entries(TABLE_ROW_HEIGHT)) {
			const td = TABLE_DENSITY_CLASSES[density as keyof typeof TABLE_DENSITY_CLASSES].td;
			const match = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/.exec(td);
			expect(match, `${density}: no fixed h-* on the <td> — a py-* row height is a review failure`).not.toBeNull();
			expect(Number(match?.[1]) * 4, `${density} row height`).toBe(height);
		}
		// And the map covers exactly the ladder, so a fourth density cannot be
		// added to one table only.
		expect(Object.keys(TABLE_ROW_HEIGHT).sort()).toEqual(Object.keys(TABLE_DENSITY_CLASSES).sort());
	});
});
