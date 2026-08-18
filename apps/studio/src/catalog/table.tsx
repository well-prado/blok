import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Button } from "@/components/primitives/Buttons";
import { EmptyState } from "@/components/primitives/EmptyState";
import {
	TABLE_ROW_HEIGHT,
	Table,
	TableBlankRow,
	TableBody,
	TableCell,
	TableHeader,
	TableHeaderCell,
	TableRow,
} from "@/components/primitives/Table";
import type { TableDensity } from "@/components/primitives/Table";
import { Text } from "@/components/primitives/Text";
import { Inbox } from "lucide-react";

/**
 * `<Variant>`'s inner container is `flex flex-wrap items-center gap-3`, so a
 * bare `<table>` becomes a centred flex item and will not fill the width. Every
 * demo goes through this.
 */
function Demo({ children }: { children: React.ReactNode }) {
	return <div className="w-full">{children}</div>;
}

type Run = { id: string; status: string; duration: string; steps: number };

const RUNS: Run[] = [
	{ id: "run_01H8Z3K9", status: "Completed", duration: "1.24s", steps: 7 },
	{ id: "run_01H8Z3M2", status: "Failed", duration: "0.31s", steps: 3 },
	{ id: "run_01H8Z3P7", status: "Running", duration: "12.90s", steps: 12 },
];

// Every demo stays well under the 100-row virtualization threshold (§2.16 rule
// 2), or the frozen `catalog.test.tsx` — which renders this page bare — would
// need a `ResizeObserver` polyfill it does not have.
const SCROLLING_RUNS: Run[] = Array.from({ length: 20 }, (_, i) => ({
	id: `run_01H8Z${String(i).padStart(3, "0")}`,
	status: i % 3 === 0 ? "Completed" : "Running",
	duration: `${(i * 0.37).toFixed(2)}s`,
	steps: i + 1,
}));

// §2.11's fit invariant: a control of the paired size drops into a row without
// changing its height. If a row here grows, the ladder is wrong.
const DENSITIES: { density: TableDensity; button: "xs" | "sm" | "lg"; height: number }[] = [
	{ density: "compact", button: "xs", height: TABLE_ROW_HEIGHT.compact },
	{ density: "default", button: "sm", height: TABLE_ROW_HEIGHT.default },
	{ density: "comfortable", button: "lg", height: TABLE_ROW_HEIGHT.comfortable },
];

export default function TableCatalog() {
	return (
		<CatalogPage
			title="Table"
			description="One surface, three densities. Scale is `density` (§2.11) — never `size`, because a `default` row is 40px while an `md` control is 32px. Surface, hover and selection are fixed (§2.12); font family is a per-column decision made with `Text`."
		>
			{DENSITIES.map(({ density, button, height }) => (
				<Variant key={density} label={`density="${density}" — ${height}px rows, fits a size="${button}" control`}>
					<Demo>
						<Table aria-label={`${density} density example`} density={density}>
							<TableHeader>
								<TableRow>
									<TableHeaderCell>Run</TableHeaderCell>
									<TableHeaderCell>Status</TableHeaderCell>
									<TableHeaderCell align="right">Duration</TableHeaderCell>
									<TableHeaderCell align="right">Steps</TableHeaderCell>
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
										{/* `numeric` is mandatory on a column of numbers — proportional
										    digits make a numeric column unreadable (§2.11). */}
										<TableCell align="right">
											<Text mono numeric>
												{run.duration}
											</Text>
										</TableCell>
										<TableCell align="right">
											<Text numeric>{run.steps}</Text>
										</TableCell>
										<TableCell align="right" className="w-px">
											<Button size={button} variant="secondary">
												Replay
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Demo>
				</Variant>
			))}

			<Variant label="stickyHeader — the caller MUST bound the container's height, or nothing sticks">
				<Demo>
					<Table aria-label="Sticky header example" stickyHeader containerClassName="max-h-64">
						<TableHeader>
							<TableRow>
								<TableHeaderCell>Run</TableHeaderCell>
								<TableHeaderCell align="right">Duration</TableHeaderCell>
								<TableHeaderCell align="right">Steps</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							{SCROLLING_RUNS.map((run) => (
								<TableRow key={run.id}>
									<TableCell>
										<Text mono>{run.id}</Text>
									</TableCell>
									<TableCell align="right">
										<Text mono numeric>
											{run.duration}
										</Text>
									</TableCell>
									<TableCell align="right">
										<Text numeric>{run.steps}</Text>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			{/*
			 * Both stickies in ONE demo on purpose: the only place the z-order can go
			 * wrong is where they cross, top-right (§2.12 rule 9 — header z-20 wins
			 * over column z-10). Hover a row and the sticky cell's `bg-inherit` tracks
			 * the row's own computed background.
			 */}
			<Variant label="Sticky header × sticky right column — scroll both axes, then hover a row">
				<Demo>
					<Table aria-label="Sticky header and column example" stickyHeader containerClassName="max-h-56 max-w-md">
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
							{SCROLLING_RUNS.map((run) => (
								<TableRow key={run.id}>
									<TableCell>
										<Text mono>{run.id}</Text>
									</TableCell>
									<TableCell className="whitespace-nowrap">process-order</TableCell>
									<TableCell className="whitespace-nowrap">http.post /orders</TableCell>
									<TableCell className="whitespace-nowrap">production</TableCell>
									<TableCell isSticky align="right" className="w-px">
										<Button size="sm" variant="minimal">
											Open
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="Sort header states — the whole header is the button, named for its column">
				<Demo>
					<Table aria-label="Sort states example">
						<TableHeader>
							<TableRow>
								<TableHeaderCell sortDirection="asc" onSort={() => {}}>
									Ascending
								</TableHeaderCell>
								<TableHeaderCell sortDirection="desc" onSort={() => {}}>
									Descending
								</TableHeaderCell>
								<TableHeaderCell sortDirection={null} onSort={() => {}}>
									Sortable, cleared
								</TableHeaderCell>
								<TableHeaderCell>Not sortable</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableCell>aria-sort=&quot;ascending&quot;</TableCell>
								<TableCell>aria-sort=&quot;descending&quot;</TableCell>
								<TableCell>aria-sort=&quot;none&quot;</TableCell>
								<TableCell>no aria-sort at all</TableCell>
							</TableRow>
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			{/*
			 * There is no disabled row. A `<tr>` is a container, not a control: the
			 * row-level recipe announced "unavailable" while the buttons inside it
			 * stayed tabbable and fired on Enter. Disable the controls instead — the
			 * third row here does exactly that.
			 */}
			<Variant label="Row states — selection is opaque and beats hover; the header row does NOT hover">
				<Demo>
					<Table aria-label="Row states example">
						<TableHeader>
							<TableRow>
								<TableHeaderCell>Run</TableHeaderCell>
								<TableHeaderCell>State</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableCell>
									<Text mono>run_01H8Z3K9</Text>
								</TableCell>
								<TableCell>default — hover me</TableCell>
							</TableRow>
							<TableRow isSelected>
								<TableCell>
									<Text mono>run_01H8Z3M2</Text>
								</TableCell>
								<TableCell>isSelected — data-selected=&quot;true&quot;, no hover change</TableCell>
							</TableRow>
							<TableRow>
								<TableCell>
									<Text mono>run_01H8Z3P7</Text>
								</TableCell>
								<TableCell>
									{/* `display:flex` on a `<td>` drops it out of table layout and the
									    `h-*` row height with it — the flex box goes inside. */}
									<div className="flex items-center gap-2">
										<Button size="sm" variant="secondary" disabled>
											Replay
										</Button>
										unavailable action — the CONTROL is disabled, never the row
									</div>
								</TableCell>
							</TableRow>
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="TableBlankRow — inside the body, so the header and column widths survive">
				<Demo>
					<Table aria-label="Blank row example">
						<TableHeader>
							<TableRow>
								<TableHeaderCell>Run</TableHeaderCell>
								<TableHeaderCell>Status</TableHeaderCell>
								<TableHeaderCell align="right">Duration</TableHeaderCell>
							</TableRow>
						</TableHeader>
						<TableBody>
							{/* No colSpan passed: the 1000 default spans the table with no
							    hand-counting. The reference hand-counts it in four places. */}
							<TableBlankRow>
								<EmptyState
									icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
									title="No runs yet"
									description="Runs appear here as soon as a workflow is triggered."
								/>
							</TableBlankRow>
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="The virtualization seam — rows + renderRow is interchangeable with children">
				<Demo>
					<div className="flex flex-col gap-4">
						<Table aria-label="Seam example, rows and renderRow">
							<TableHeader>
								<TableRow>
									<TableHeaderCell>rows + renderRow</TableHeaderCell>
									<TableHeaderCell align="right">Duration</TableHeaderCell>
								</TableRow>
							</TableHeader>
							{/* E2-T6 replaces this one expression's internals with a windowed
							    render and changes nothing else, anywhere. */}
							<TableBody
								rows={RUNS}
								renderRow={(run) => (
									<TableRow key={run.id}>
										<TableCell>
											<Text mono>{run.id}</Text>
										</TableCell>
										<TableCell align="right">
											<Text mono numeric>
												{run.duration}
											</Text>
										</TableCell>
									</TableRow>
								)}
							/>
						</Table>
						<Table aria-label="Seam example, children">
							<TableHeader>
								<TableRow>
									<TableHeaderCell>children</TableHeaderCell>
									<TableHeaderCell align="right">Duration</TableHeaderCell>
								</TableRow>
							</TableHeader>
							<TableBody>
								{RUNS.map((run) => (
									<TableRow key={run.id}>
										<TableCell>
											<Text mono>{run.id}</Text>
										</TableCell>
										<TableCell align="right">
											<Text mono numeric>
												{run.duration}
											</Text>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</Demo>
			</Variant>
		</CatalogPage>
	);
}
