import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { BulkActionBar } from "@/components/primitives/BulkActionBar";
import { Button } from "@/components/primitives/Buttons";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@/components/primitives/Table";
import { TableSelectAllCell, TableSelectCell } from "@/components/primitives/TableSelectCell";
import { Text } from "@/components/primitives/Text";
import { useTableSelection } from "@/hooks/useTableSelection";
import { Download, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

/**
 * `<Variant>`'s inner container is `flex flex-wrap items-center gap-3`, so a
 * bare `<table>` becomes a centred flex item and will not fill the width.
 */
function Demo({ children }: { children: ReactNode }) {
	return <div className="w-full space-y-3">{children}</div>;
}

type Run = { id: string; status: string; duration: string; locked: boolean };

const RUNS: Run[] = [
	{ id: "run_01H8Z3K9", status: "Completed", duration: "1.24s", locked: false },
	{ id: "run_01H8Z3M2", status: "Failed", duration: "0.31s", locked: false },
	{ id: "run_01H8Z3P7", status: "Running", duration: "12.90s", locked: true },
	{ id: "run_01H8Z3Q1", status: "Completed", duration: "3.02s", locked: false },
];

// The hook's `ids` are the SELECTABLE rows, so a locked run is excluded. Include
// it and select-all checks a DISABLED checkbox the user can then never uncheck —
// measured in a browser before this line existed.
const SELECTABLE_IDS = RUNS.filter((run) => !run.locked).map((run) => run.id);

function SelectableRuns({ max }: { max?: number }) {
	// ONE model, owned by the caller (§2.14). The bulk bar and the row highlight
	// read the same hook, so they cannot drift.
	const selection = useTableSelection(SELECTABLE_IDS, max === undefined ? undefined : { max });

	return (
		<Demo>
			<BulkActionBar count={selection.selected.size} max={max} atMax={selection.atMax} onClear={selection.clear}>
				<Button size="sm" leadingIcon={<RotateCcw />}>
					Replay
				</Button>
				<Button size="sm" leadingIcon={<Download />}>
					Export
				</Button>
			</BulkActionBar>
			<Table aria-label={max === undefined ? "Selectable runs" : "Selectable runs with a cap"}>
				<TableHeader>
					<TableRow>
						<TableSelectAllCell
							total={SELECTABLE_IDS.length}
							allSelected={selection.allSelected}
							someSelected={selection.someSelected}
							onToggleAll={() => (selection.allSelected ? selection.clear() : selection.selectAll())}
						/>
						<TableHeaderCell>Run</TableHeaderCell>
						<TableHeaderCell>Status</TableHeaderCell>
						<TableHeaderCell align="right">Duration</TableHeaderCell>
					</TableRow>
				</TableHeader>
				<TableBody>
					{RUNS.map((run) => (
						<TableRow key={run.id} isSelected={selection.has(run.id)}>
							{/* A row that cannot be selected disables its CONTROL. There is no
							    disabled row: a `<tr>` is a container, not a control (§2.13). */}
							<TableSelectCell
								label={run.id}
								checked={selection.has(run.id)}
								disabled={run.locked}
								onToggle={(extend) => selection.toggle(run.id, extend)}
							/>
							<TableCell>
								<Text mono>{run.id}</Text>
							</TableCell>
							<TableCell>{run.status}</TableCell>
							<TableCell align="right">
								<Text mono numeric>
									{run.duration}
								</Text>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Demo>
	);
}

export default function TableSelectionCatalog() {
	return (
		<CatalogPage
			title="Table selection"
			description="Checkbox column, select-all with a real indeterminate state, and the bulk-action bar. Selection is a hook the caller owns (§2.14) — the table never owns it, and it is conveyed by the checkbox, never by aria-selected."
		>
			<Variant label="Live — click rows, shift-click to extend a range, then Clear">
				<SelectableRuns />
			</Variant>

			<Variant label="Capped selection — max=2, refused with a visible message, never truncated silently">
				<SelectableRuns max={2} />
			</Variant>

			<Variant label="Checkbox states — the cell's every state, including disabled">
				<Demo>
					<Table aria-label="Selection cell states">
						<TableHeader>
							<TableRow>
								<TableHeaderCell hiddenLabel>Select</TableHeaderCell>
								<TableHeaderCell>State</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableSelectCell label="the unselected row" checked={false} onToggle={() => {}} />
								<TableCell>unchecked</TableCell>
							</TableRow>
							<TableRow isSelected>
								<TableSelectCell label="the selected row" checked onToggle={() => {}} />
								<TableCell>checked — the row takes the opaque selected surface</TableCell>
							</TableRow>
							<TableRow>
								<TableSelectCell label="the locked row" checked={false} disabled onToggle={() => {}} />
								<TableCell>disabled</TableCell>
							</TableRow>
							<TableRow isSelected>
								<TableSelectCell label="the locked selected row" checked disabled onToggle={() => {}} />
								<TableCell>disabled + checked</TableCell>
							</TableRow>
						</TableBody>
					</Table>
					<p className="text-xs text-ink-muted">
						Focus is not a prop: Tab into the table and the checkbox takes `.focus-ring` (§2.7). Every checkbox above is
						an ordinary tab stop with no tabIndex of its own (§2.15 rule 3), so tabbing walks them in row order.
					</p>
				</Demo>
			</Variant>

			<Variant label="Select-all states — the three the header checkbox can be in">
				<Checkbox size="sm" checked={false} readOnly label="unchecked — nothing selected" />
				<Checkbox
					size="sm"
					checked={false}
					readOnly
					ref={(element) => {
						if (element) element.indeterminate = true;
					}}
					label="indeterminate — some selected"
				/>
				<Checkbox size="sm" checked readOnly label="checked — all selected" />
				<Checkbox size="sm" checked={false} disabled label="disabled — nothing selectable" />
			</Variant>

			<Variant label="Bulk bar — empty renders nothing, so only the populated forms show">
				<Demo>
					<BulkActionBar count={1} onClear={() => {}}>
						<Button size="sm" leadingIcon={<RotateCcw />}>
							Replay
						</Button>
					</BulkActionBar>
					<BulkActionBar count={12} onClear={() => {}} note={<span>· 4 non-HTTP, replay-skip</span>}>
						<Button size="sm" leadingIcon={<RotateCcw />}>
							Replay 8
						</Button>
						<Button size="sm" disabled leadingIcon={<Download />}>
							Export
						</Button>
					</BulkActionBar>
					<BulkActionBar count={2} max={2} atMax onClear={() => {}}>
						<Button size="sm" leadingIcon={<RotateCcw />}>
							Replay
						</Button>
					</BulkActionBar>
				</Demo>
			</Variant>
		</CatalogPage>
	);
}
