import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Accordion, AccordionItem } from "@/components/primitives/Accordion";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	SimpleDialog,
} from "@/components/primitives/Dialog";
import { ExportMenu, SimpleDropdownMenu } from "@/components/primitives/DropdownMenu";
import { SimplePopover } from "@/components/primitives/Popover";
import { SimpleSheet } from "@/components/primitives/Sheet";
import { cn } from "@/lib/utils";
import { RotateCcw, Trash2 } from "lucide-react";

// No Button primitive here on purpose: T3 owns it and cross-task imports are
// banned (CONVENTIONS §12.4), so these triggers are plain token-styled buttons.
const trigger = cn(
	"focus-ring inline-flex h-8 items-center gap-2 rounded-md border border-line bg-control px-3 text-sm text-ink",
	"transition-colors hover:bg-hover hover:text-ink-strong disabled:pointer-events-none disabled:opacity-50",
);

const sides = ["top", "right", "bottom", "left"] as const;
const aligns = ["start", "center", "end"] as const;

export default function OverlaysCatalog() {
	return (
		<CatalogPage
			title="Overlays"
			description="Dialog, Sheet, Popover and DropdownMenu are Radix wrappers — focus trap, focus return, Escape and scroll lock come from the library and are not disabled. Accordion is native <details>. Every floating surface obeys the §2.9 elevation ladder."
		>
			<Variant label="Dialog — compound parts">
				<Dialog>
					<DialogTrigger className={trigger}>Open dialog</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Replay run_01HXYZ</DialogTitle>
							<DialogDescription>Re-runs every step with the original trigger payload.</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<p>Focus is trapped here. Tab around, then press Escape — focus lands back on the trigger.</p>
						</DialogBody>
						<DialogFooter>
							<DialogClose className={trigger}>Cancel</DialogClose>
							<DialogClose className={cn(trigger, "border-transparent bg-accent font-semibold text-on-accent")}>
								Replay
							</DialogClose>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</Variant>

			<Variant label="Dialog — SimpleDialog flattened wrapper, and a wide one via className">
				<SimpleDialog
					trigger={
						<button type="button" className={trigger}>
							Simple dialog
						</button>
					}
					title="Delete workflow"
					description="This cannot be undone."
					footer={<DialogClose className={trigger}>Close</DialogClose>}
				>
					Four props instead of seven components.
				</SimpleDialog>
				<SimpleDialog
					trigger={
						<button type="button" className={trigger}>
							Wide dialog
						</button>
					}
					title="Payload"
					className="max-w-3xl"
				>
					There is no size prop — the §2.4 ladder is control heights, so width is just className.
				</SimpleDialog>
			</Variant>

			<Variant label="Sheet — every side">
				{sides.map((side) => (
					<SimpleSheet
						key={side}
						side={side}
						trigger={
							<button type="button" className={trigger}>
								{side}
							</button>
						}
						title={`Sheet: ${side}`}
						description="Same Radix dialog, anchored to an edge."
					>
						<p>Cross-axis extent is the caller's className.</p>
					</SimpleSheet>
				))}
			</Variant>

			<Variant label="Popover — every alignment">
				{aligns.map((align) => (
					<SimplePopover
						key={align}
						align={align}
						trigger={
							<button type="button" className={trigger}>
								align={align}
							</button>
						}
						heading="Visible columns"
					>
						<p className="max-w-52 text-ink-dimmed">
							Arbitrary content, not commands. Non-modal: click outside to dismiss.
						</p>
					</SimplePopover>
				))}
			</Variant>

			<Variant label="DropdownMenu — item tones, disabled item, and the ExportMenu fold-in">
				<SimpleDropdownMenu
					label="Run actions"
					trigger={
						<button type="button" className={trigger}>
							Actions
						</button>
					}
					items={[
						{ label: "Replay run", onSelect: () => {}, icon: RotateCcw },
						{ label: "Cancel run", onSelect: () => {}, disabled: true },
						{ label: "Delete run", onSelect: () => {}, icon: Trash2, tone: "error" },
					]}
				/>
				<ExportMenu size="sm" onExportJson={() => {}} onExportCsv={() => {}} />
				<ExportMenu size="md" label="Export (md)" onExportJson={() => {}} onExportCsv={() => {}} />
			</Variant>

			<Variant label="Accordion — native <details>, independent items">
				<Accordion className="w-full max-w-lg">
					<AccordionItem title="Inputs" aside={<span className="text-xs text-ink-muted">3 keys</span>}>
						Enter or Space on the summary toggles it — no JS involved.
					</AccordionItem>
					<AccordionItem title="Outputs" defaultOpen>
						Open by default via the native `open` attribute.
					</AccordionItem>
					<AccordionItem title="Locked" disabled>
						Never reachable.
					</AccordionItem>
				</Accordion>
			</Variant>

			<Variant label="Accordion — exclusive, via the native name attribute">
				<Accordion exclusive className="w-full max-w-lg">
					<AccordionItem title="Attempt 1">Opening a sibling closes this one.</AccordionItem>
					<AccordionItem title="Attempt 2">…and vice versa.</AccordionItem>
					<AccordionItem title="Attempt 3">No state, no effect, no library.</AccordionItem>
				</Accordion>
			</Variant>
		</CatalogPage>
	);
}
