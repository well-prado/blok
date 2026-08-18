import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Button } from "@/components/primitives/Buttons";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@/components/primitives/Table";
import { Text } from "@/components/primitives/Text";

/**
 * E2-T3 (issue 780) — row hover, row keyboard focus, and arrow-key navigation
 * between rows.
 *
 * A separate slug from `table` on purpose: several Wave-B/C branches were in
 * flight against `src/catalog/table.tsx` at once, and the glob in
 * `lib/catalogPages.ts` registers this page with no shared-file edit
 * (CONVENTIONS §7). §12.5 originally said T3 "appends to `table`"; the
 * file-per-task rule is the one that keeps a wave conflict-free, so this page
 * follows that instead and §12.5's row is corrected accordingly.
 *
 * Every link here is a plain `<a>` pointing back at this same page: the frozen
 * `catalog.test.tsx` renders this page with NO `RouterProvider`, so a TanStack
 * `<Link>` would crash the whole suite (§7.3), and `Table.tsx` deliberately
 * imports no router at all. A bare `href="#"` plus a suppressed click is not the
 * alternative — Biome's `useValidAnchor` rejects it, and §9 forbids silencing an
 * a11y rule.
 */

type Run = { id: string; workflow: string; status: string; duration: string };

const RUNS: Run[] = [
	{ id: "run_01H8Z3K9", workflow: "process-order", status: "Completed", duration: "1.24s" },
	{ id: "run_01H8Z3M2", workflow: "send-receipt", status: "Failed", duration: "0.31s" },
	{ id: "run_01H8Z3P7", workflow: "archive-run", status: "Running", duration: "12.90s" },
	{ id: "run_01H8Z3R1", workflow: "process-order", status: "Completed", duration: "0.08s" },
];

/** `<Variant>`'s inner box is a wrapping flex row, so a bare table will not fill it. */
function Demo({ children }: { children: React.ReactNode }) {
	return <div className="w-full">{children}</div>;
}

export default function TableKeyboardCatalog() {
	return (
		<CatalogPage
			title="Table rows — hover, focus, keyboard"
			description="Rows highlight under the mouse AND under keyboard focus, and ↑/↓ walk between them. The arrows are a progressive enhancement layered on Tab: no row is focusable, no tabIndex is rewritten, and every control in a row keeps its ordinary tab stop (§2.15 rule 3)."
		>
			<Variant label="↑/↓ move between rows — Tab into the table first, then arrow">
				<Demo>
					<div className="flex flex-col gap-2">
						<Table aria-label="Runs, arrow-navigable">
							<TableHeader>
								<TableRow>
									<TableHeaderCell>Run</TableHeaderCell>
									<TableHeaderCell>Status</TableHeaderCell>
									<TableHeaderCell align="right">Duration</TableHeaderCell>
									<TableHeaderCell align="right" hiddenLabel>
										Actions
									</TableHeaderCell>
								</TableRow>
							</TableHeader>
							<TableBody>
								{RUNS.map((run) => (
									<TableRow key={run.id}>
										<TableCell>
											{/* The row's primary link: first ordinary link in the row, so
											    it needs no marker. */}
											<a href="/catalog/table-keyboard" className="focus-ring rounded-md hover:text-accent">
												<Text mono>{run.id}</Text>
											</a>
										</TableCell>
										<TableCell>{run.status}</TableCell>
										<TableCell align="right">
											<Text mono numeric>
												{run.duration}
											</Text>
										</TableCell>
										<TableCell align="right" className="w-px">
											{/* A second tab stop in the row. The arrows never remove it —
											    that is the difference between this and a roving tabindex. */}
											<Button size="sm" variant="minimal">
												Replay
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<Text size="sm" ink="dimmed">
							Tab reaches every control in a row (here: the id link, then Replay). ↑/↓ jump straight to the next
							row&rsquo;s primary link — and at the first and last row they do nothing, so the page still scrolls.
						</Text>
					</div>
				</Demo>
			</Variant>

			<Variant label="data-row-primary — when the record's link is not the row's first link">
				<Demo>
					<div className="flex flex-col gap-2">
						<Table aria-label="Runs, primary link marked">
							<TableHeader>
								<TableRow>
									<TableHeaderCell>Workflow</TableHeaderCell>
									<TableHeaderCell>Run</TableHeaderCell>
									<TableHeaderCell align="right">Duration</TableHeaderCell>
								</TableRow>
							</TableHeader>
							<TableBody>
								{RUNS.map((run) => (
									<TableRow key={run.id}>
										<TableCell>
											<a href="/catalog/table-keyboard" className="focus-ring rounded-md hover:text-accent">
												{run.workflow}
											</a>
										</TableCell>
										<TableCell>
											<a
												href="/catalog/table-keyboard"
												data-row-primary
												className="focus-ring rounded-md hover:text-accent"
											>
												<Text mono>{run.id}</Text>
											</a>
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
						<Text size="sm" ink="dimmed">
							The workflow link comes first in the DOM but is not what the row is about, so the run link carries
							<Text mono> data-row-primary</Text> and the arrows land there. Tab order is untouched.
						</Text>
					</div>
				</Demo>
			</Variant>

			<Variant label="Row states — hover and keyboard focus paint the same row background; selection beats both">
				<Demo>
					<div className="flex flex-col gap-2">
						<Table aria-label="Row focus states">
							<TableHeader>
								<TableRow>
									<TableHeaderCell>Run</TableHeaderCell>
									<TableHeaderCell>State</TableHeaderCell>
								</TableRow>
							</TableHeader>
							<TableBody>
								<TableRow>
									<TableCell>
										<a href="/catalog/table-keyboard" className="focus-ring rounded-md hover:text-accent">
											<Text mono>run_01H8Z3K9</Text>
										</a>
									</TableCell>
									<TableCell>hover me, or Tab to the link — the whole row lights up either way</TableCell>
								</TableRow>
								<TableRow isSelected>
									<TableCell>
										<a href="/catalog/table-keyboard" className="focus-ring rounded-md hover:text-accent">
											<Text mono>run_01H8Z3M2</Text>
										</a>
									</TableCell>
									<TableCell>isSelected — the selected background wins over both hover and focus</TableCell>
								</TableRow>
								<TableRow>
									<TableCell>
										<Text mono>run_01H8Z3P7</Text>
									</TableCell>
									<TableCell>no control at all — the arrows step straight over this row</TableCell>
								</TableRow>
							</TableBody>
						</Table>
						<Text size="sm" ink="dimmed">
							The row highlight is <Text mono>has-[:focus-visible]</Text>, never <Text mono>:focus-within</Text>: a
							mouse click must not paint a keyboard-focus state. The focus RING stays on the control itself.
						</Text>
					</div>
				</Demo>
			</Variant>
		</CatalogPage>
	);
}
