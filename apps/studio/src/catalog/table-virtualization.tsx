import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@/components/primitives/Table";
import { Text } from "@/components/primitives/Text";

/**
 * E2-T6 (issue 783) — windowing, i.e. the seam CONVENTIONS §2.16 left in
 * `<TableBody rows renderRow>` for exactly this task.
 *
 * Its own slug rather than an append to `table`: E2-T2 and E2-T3 were both in
 * flight against `src/catalog/table.tsx`, and a new file costs nothing because
 * the glob in `lib/catalogPages.ts` registers it with no shared edit
 * (CONVENTIONS §7, and the same call E2-T3 made for `table-keyboard`).
 *
 * The big demo deliberately exceeds the 100-row gate, which is what makes it a
 * demo at all. That is safe in the frozen `catalog.test.tsx` — verified, not
 * assumed: `@tanstack/react-virtual` checks for `ResizeObserver` before using it,
 * so in jsdom the container measures 0px, the window is empty, and the page
 * renders its heading exactly as the test requires. Nothing throws.
 *
 * Links are plain `<a>` back to this page: the frozen catalog test renders every
 * page with NO `RouterProvider`, so a TanStack `<Link>` would take the whole
 * suite down (§7.3).
 */

type Run = { id: string; workflow: string; status: string; duration: string };

const WORKFLOWS = ["process-order", "send-receipt", "archive-run", "reindex-search", "sync-inventory"];
const STATUSES = ["Completed", "Failed", "Running", "Queued"];

/** Deterministic, so two renders of this page never disagree. */
function makeRuns(count: number): Run[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `run_01H8Z3${i.toString(36).toUpperCase().padStart(4, "0")}`,
		workflow: WORKFLOWS[i % WORKFLOWS.length] ?? "process-order",
		status: STATUSES[i % STATUSES.length] ?? "Completed",
		duration: `${((i % 97) / 7 + 0.08).toFixed(2)}s`,
	}));
}

const MANY = makeRuns(1000);
const FEW = makeRuns(99);

/** `<Variant>`'s inner box is a wrapping flex row, so a bare table will not fill it. */
function Demo({ children }: { children: React.ReactNode }) {
	return <div className="w-full">{children}</div>;
}

function RunsTable({ rows, label }: { rows: Run[]; label: string }) {
	return (
		<Table aria-label={label} stickyHeader containerClassName="max-h-[60vh]">
			<TableHeader>
				<TableRow>
					<TableHeaderCell>Run</TableHeaderCell>
					<TableHeaderCell>Workflow</TableHeaderCell>
					<TableHeaderCell>Status</TableHeaderCell>
					<TableHeaderCell align="right">Duration</TableHeaderCell>
				</TableRow>
			</TableHeader>
			{/*
			 * The seam: `rows` + `renderRow` instead of children. Above 100 rows
			 * `TableBody` renders a window of them between two spacer rows; below it,
			 * every row. The caller writes the same thing either way — that was the
			 * promise §2.16 had to keep.
			 */}
			<TableBody
				rows={rows}
				renderRow={(run) => (
					<TableRow key={run.id}>
						<TableCell>
							<a href="/catalog/table-virtualization" className="focus-ring rounded-md hover:text-accent">
								<Text mono>{run.id}</Text>
							</a>
						</TableCell>
						<TableCell>{run.workflow}</TableCell>
						<TableCell>{run.status}</TableCell>
						<TableCell align="right">
							<Text mono numeric>
								{run.duration}
							</Text>
						</TableCell>
					</TableRow>
				)}
			/>
		</Table>
	);
}

export default function TableVirtualizationCatalog() {
	return (
		<CatalogPage
			title="Table virtualization"
			description="Past 100 rows the body renders only the rows near the viewport, between two spacer rows. It stays a real <table>, so the sticky header, the column widths and arrow-key row navigation all survive — and aria-rowcount / aria-rowindex start telling the truth about rows that are not in the DOM."
		>
			<Variant label="1,000 rows — windowed. Scroll it; the DOM holds a few dozen rows, never a thousand">
				<Demo>
					<div className="flex flex-col gap-2">
						<RunsTable rows={MANY} label="1,000 runs, windowed" />
						<Text size="sm" ink="dimmed">
							The scroll height comes from two spacer rows above and below the window, never from absolute positioning:
							a translated div inside a table body stops the element being a real table, which would kill both the
							column model and the sticky header. Because the DOM is now incomplete, the table carries{" "}
							<Text mono>aria-rowcount=1001</Text> and every rendered row its absolute <Text mono>aria-rowindex</Text>{" "}
							(the header row is 1). The spacers are hidden from assistive tech and carry no index.
						</Text>
					</div>
				</Demo>
			</Variant>

			<Variant label="99 rows — the same markup, below the gate, every row in the DOM">
				<Demo>
					<div className="flex flex-col gap-2">
						<RunsTable rows={FEW} label="99 runs, not windowed" />
						<Text size="sm" ink="dimmed">
							Identical call site. Under 100 rows the virtualizer&rsquo;s count is 0, so it measures nothing and the
							plain path renders — which is also why the test suite needs no <Text mono>ResizeObserver</Text> polyfill.
							No <Text mono>aria-rowcount</Text> here either: the DOM already holds every row, and a second place to
							state the count is a second place to be wrong.
						</Text>
					</div>
				</Demo>
			</Variant>
		</CatalogPage>
	);
}
