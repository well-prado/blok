import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Button } from "@/components/primitives/Buttons";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@/components/primitives/Table";
import { TableEmpty, TableLoadingOverlay, TableNoResults } from "@/components/primitives/TableBlankState";
import { Text } from "@/components/primitives/Text";
import { Inbox } from "lucide-react";
import { useState } from "react";

/**
 * `<Variant>`'s inner container is `flex flex-wrap items-center gap-3`, so a bare
 * `<table>` becomes a centred flex item. Every demo goes through this.
 */
function Demo({ children }: { children: React.ReactNode }) {
	return <div className="w-full">{children}</div>;
}

type Run = { id: string; status: string; duration: string };

const RUNS: Run[] = [
	{ id: "run_01H8Z3K9", status: "Completed", duration: "1.24s" },
	{ id: "run_01H8Z3M2", status: "Failed", duration: "0.31s" },
	{ id: "run_01H8Z3P7", status: "Running", duration: "12.90s" },
];

/** Three real columns in every demo, so the blank body has a real width to span. */
function Head() {
	return (
		<TableHeader>
			<TableRow>
				<TableHeaderCell>Run</TableHeaderCell>
				<TableHeaderCell>Status</TableHeaderCell>
				<TableHeaderCell align="right">Duration</TableHeaderCell>
			</TableRow>
		</TableHeader>
	);
}

function Rows() {
	return RUNS.map((run) => (
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
		</TableRow>
	));
}

const inbox = <Inbox aria-hidden="true" className="h-6 w-6" />;

/**
 * The no-results state with a filter that really is applied and really clears,
 * because the whole point of this state is that its action does the ONE thing
 * the empty state must not offer.
 */
function FilterDemo() {
	const [filtered, setFiltered] = useState(true);
	return (
		<div className="flex w-full flex-col gap-3">
			<div className="flex items-center gap-3">
				<Text ink="dimmed">status:cancelled</Text>
				<Button size="sm" variant="minimal" onClick={() => setFiltered((f) => !f)}>
					{filtered ? "Apply a matching filter" : "Apply a filter that matches nothing"}
				</Button>
			</div>
			<Table aria-label="No results example">
				<Head />
				<TableBody>{filtered ? <TableNoResults onClearFilters={() => setFiltered(false)} /> : <Rows />}</TableBody>
			</Table>
		</div>
	);
}

export default function TableBlankStatesCatalog() {
	return (
		<CatalogPage
			title="Table blank states"
			description="Three blank bodies, inside `<TableBody>` so the header and the column widths survive. `empty` and `no-results` are different components on purpose: nothing-has-ever-been-here offers the action that CREATES the first record, a filter that matched nothing offers to CLEAR the filter. E2 owns the table shape; E11-T4 owns the copy."
		>
			<Variant label="empty — nothing has ever been here, so the offer is to create the first record">
				<Demo>
					<Table aria-label="Empty example">
						<Head />
						<TableBody>
							<TableEmpty
								icon={inbox}
								title="No runs yet"
								description="Runs appear here as soon as a workflow is triggered."
								action={<Button variant="primary">New workflow</Button>}
							/>
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="no-results — the records may exist behind the filter, so the offer is to clear it">
				<FilterDemo />
			</Variant>

			<Variant label="Disabled — the ACTION is disabled natively; nothing ever disables the row (§2.6)">
				<Demo>
					<Table aria-label="Disabled action example">
						<Head />
						<TableBody>
							<TableEmpty
								icon={inbox}
								title="No runs yet"
								description="You do not have permission to create a workflow in this environment."
								action={
									<Button variant="primary" disabled>
										New workflow
									</Button>
								}
							/>
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="No handler — no control at all, rather than a Clear filters button that clears nothing">
				<Demo>
					<Table aria-label="No clear handler example">
						<Head />
						<TableBody>
							<TableNoResults />
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="Focus — the action is an ordinary tab stop: press Tab, and the ring is `.focus-ring`">
				<Demo>
					<Table aria-label="Focus example">
						<Head />
						<TableBody>
							<TableNoResults onClearFilters={() => {}} />
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="loading — an overlay over the rows that are already there, so the table does not reflow">
				<Demo>
					<Table aria-label="Loading overlay example">
						<Head />
						{/* `<TableBody>` is `relative` for exactly this (§2.16). */}
						<TableBody>
							<Rows />
							<TableLoadingOverlay />
						</TableBody>
					</Table>
				</Demo>
			</Variant>

			<Variant label="colSpan — the 1000 default spans any table; table-layout: fixed is the one case that needs a real count">
				<Demo>
					<Table aria-label="Fixed layout example" className="table-fixed">
						<Head />
						<TableBody>
							<TableNoResults colSpan={3} />
						</TableBody>
					</Table>
				</Demo>
			</Variant>
		</CatalogPage>
	);
}
