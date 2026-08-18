import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import type { DropdownMenuEntry } from "@/components/primitives/DropdownMenu";
import {
	Table,
	TableBody,
	TableCell,
	type TableDensity,
	TableHeader,
	TableHeaderCell,
	TableRow,
} from "@/components/primitives/Table";
import { TableRowActions } from "@/components/primitives/TableRowActions";
import { Text } from "@/components/primitives/Text";
import { Ban, RotateCcw, SquareArrowOutUpRight, Trash2 } from "lucide-react";

/**
 * `<Variant>`'s inner container is `flex flex-wrap items-center gap-3`, so a
 * bare `<table>` becomes a centred flex item and will not fill the width.
 */
function Demo({ children }: { children: React.ReactNode }) {
	return <div className="w-full">{children}</div>;
}

const noop = () => {};

const ACTIONS: DropdownMenuEntry[] = [
	{ label: "Replay run", onSelect: noop, icon: RotateCcw },
	{ label: "Open in new tab", onSelect: noop, icon: SquareArrowOutUpRight },
	// `disabled` is the item-level state: Radix supplies `aria-disabled` and
	// swallows the select, and the two §2.6 classes supply the rest.
	{ label: "Cancel run", onSelect: noop, icon: Ban, disabled: true },
	// `error`, never `danger` — red has exactly one name (§2.10 rule 4).
	{ label: "Delete run", onSelect: noop, icon: Trash2, tone: "error" },
];

type Run = { id: string; status: string; duration: string };

const RUNS: Run[] = [
	{ id: "run_01H8Z3K9", status: "Completed", duration: "1.24s" },
	{ id: "run_01H8Z3M2", status: "Failed", duration: "0.31s" },
	{ id: "run_01H8Z3P7", status: "Running", duration: "12.90s" },
];

const WIDE_RUNS: Run[] = Array.from({ length: 12 }, (_, i) => ({
	id: `run_01H8Z${String(i).padStart(3, "0")}`,
	status: i % 3 === 0 ? "Completed" : "Running",
	duration: `${(i * 0.37).toFixed(2)}s`,
}));

const DENSITIES: { density: TableDensity; trigger: string }[] = [
	{ density: "compact", trigger: "24×24" },
	{ density: "default", trigger: "28×28" },
	{ density: "comfortable", trigger: "28×28" },
];

export default function TableActionsCatalog() {
	return (
		<CatalogPage
			title="Table actions"
			description="The row-action menu. Hover a row to reveal it — then put the mouse away and press Tab: it is a permanent tab stop, revealed by opacity and never by display:none, which is the reference's keyboard-unreachable bug (§2.15 rule 7)."
		>
			{DENSITIES.map(({ density, trigger }) => (
				<Variant key={density} label={`density="${density}" — ${trigger} trigger, read from context`}>
					<Demo>
						<Table aria-label={`${density} density row actions`} density={density}>
							<TableHeader>
								<TableRow>
									<TableHeaderCell>Run</TableHeaderCell>
									<TableHeaderCell>Status</TableHeaderCell>
									<TableHeaderCell align="right">Duration</TableHeaderCell>
									{/* The action column has no visible header, but it still has a
									    name for assistive tech. */}
									<TableHeaderCell align="right" hiddenLabel>
										Actions
									</TableHeaderCell>
								</TableRow>
							</TableHeader>
							<TableBody>
								{RUNS.map((run) => (
									<TableRow key={run.id}>
										<TableCell>
											<Text mono>{run.id}</Text>
										</TableCell>
										<TableCell>{run.status}</TableCell>
										<TableCell align="right">
											<Text mono numeric>
												{run.duration}
											</Text>
										</TableCell>
										<TableRowActions items={ACTIONS} rowLabel={run.id} />
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Demo>
				</Variant>
			))}

			<Variant label="Menu states — a disabled item, a destructive item, and an item with no icon">
				<Demo>
					<Table aria-label="Menu states">
						<TableHeader>
							<TableRow>
								<TableHeaderCell>Run</TableHeaderCell>
								<TableHeaderCell>What its menu holds</TableHeaderCell>
								<TableHeaderCell align="right" hiddenLabel>
									Actions
								</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableCell>
									<Text mono>run_01H8Z3K9</Text>
								</TableCell>
								<TableCell>every state — replay, open, disabled cancel, destructive delete</TableCell>
								<TableRowActions items={ACTIONS} rowLabel="run_01H8Z3K9" />
							</TableRow>
							<TableRow>
								<TableCell>
									<Text mono>run_01H8Z3M2</Text>
								</TableCell>
								<TableCell>one action, no icon</TableCell>
								<TableRowActions items={[{ label: "Replay run", onSelect: noop }]} rowLabel="run_01H8Z3M2" />
							</TableRow>
							<TableRow>
								<TableCell>
									<Text mono>run_01H8Z3P7</Text>
								</TableCell>
								<TableCell>every action disabled — the menu opens onto four dead items</TableCell>
								<TableRowActions items={ACTIONS.map((item) => ({ ...item, disabled: true }))} rowLabel="run_01H8Z3P7" />
							</TableRow>
							<TableRow>
								<TableCell>
									<Text mono>run_01H8Z3Q1</Text>
								</TableCell>
								<TableCell>
									no actions at all — no trigger is rendered, but the cell stays so the column keeps its width
								</TableCell>
								<TableRowActions items={[]} rowLabel="run_01H8Z3Q1" />
							</TableRow>
							<TableRow isSelected>
								<TableCell>
									<Text mono>run_01H8Z3R4</Text>
								</TableCell>
								<TableCell>a selected row — the sticky cell tracks the selected paint with bg-inherit</TableCell>
								<TableRowActions items={ACTIONS} rowLabel="run_01H8Z3R4" />
							</TableRow>
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			{/*
			 * The reveal has four independent triggers and this is the demo that
			 * exercises the two a mouse cannot: Tab to the trigger with no hover, and
			 * keep it visible while the pointer sits inside the portaled menu.
			 */}
			<Variant label="Keyboard — Tab lands on every action trigger in order, with no mouse anywhere near the table">
				<Demo>
					<Table aria-label="Keyboard reachability">
						<TableHeader>
							<TableRow>
								<TableHeaderCell>Run</TableHeaderCell>
								<TableHeaderCell>Press Tab from here</TableHeaderCell>
								<TableHeaderCell align="right" hiddenLabel>
									Actions
								</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							{RUNS.map((run, i) => (
								<TableRow key={run.id}>
									<TableCell>
										<Text mono>{run.id}</Text>
									</TableCell>
									<TableCell>
										{i === 0
											? "focus-visible: the trigger paints itself in, then Enter or Space opens the menu"
											: "group-focus-within/row: focus anywhere in the row reveals it"}
									</TableCell>
									<TableRowActions items={ACTIONS} rowLabel={run.id} />
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="Sticky action column — scroll sideways; the menu still renders above both stickies">
				<Demo>
					<Table aria-label="Sticky action column" stickyHeader containerClassName="max-h-56 max-w-md">
						<TableHeader>
							<TableRow>
								<TableHeaderCell>Run</TableHeaderCell>
								<TableHeaderCell>Workflow</TableHeaderCell>
								<TableHeaderCell>Trigger</TableHeaderCell>
								<TableHeaderCell>Environment</TableHeaderCell>
								<TableHeaderCell align="right" hiddenLabel>
									Actions
								</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							{WIDE_RUNS.map((run) => (
								<TableRow key={run.id}>
									<TableCell>
										<Text mono>{run.id}</Text>
									</TableCell>
									<TableCell className="whitespace-nowrap">process-order</TableCell>
									<TableCell className="whitespace-nowrap">http.post /orders</TableCell>
									<TableCell className="whitespace-nowrap">production</TableCell>
									<TableRowActions items={ACTIONS} rowLabel={run.id} />
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Demo>
			</Variant>
		</CatalogPage>
	);
}
