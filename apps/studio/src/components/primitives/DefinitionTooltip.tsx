import { SimpleTooltip, type TooltipContentProps, type TooltipVariant } from "@/components/primitives/Tooltip";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * DefinitionTooltip — hover (or focus) a Blok domain term, get its meaning.
 *
 * This is the primitive that makes the product teachable in place: a new user
 * reading a run page meets "idempotency key" and "subworkflow" with no idea
 * what they are, and the alternative to this is a docs round-trip.
 *
 * The term is a KEY, not free text. A closed union means a typo is a typecheck
 * error rather than a silently definition-less underline, and it keeps one
 * canonical wording per concept instead of eight call sites each explaining
 * `forEach` slightly differently.
 */
export const BLOK_GLOSSARY = {
	workflow: {
		label: "Workflow",
		definition:
			"A named, versioned sequence of steps with exactly one trigger. It is the unit you deploy, run, and observe — a workflow file exports one workflow.",
	},
	node: {
		label: "Node",
		definition:
			"The reusable unit of work. A node declares Zod input and output schemas and an execute function; the same node can be used by any number of workflows.",
	},
	step: {
		label: "Step",
		definition:
			"One invocation of a node inside a workflow, under an id unique to that workflow. A successful step persists its output to state under that id; a step that throws persists nothing.",
	},
	trigger: {
		label: "Trigger",
		definition:
			"What starts a run: an HTTP route, a schedule, a worker queue, a pub/sub event, or an RPC call. Its payload is the entry handle the workflow reads from.",
	},
	run: {
		label: "Run",
		definition:
			"A single execution of one workflow version, from trigger to terminal status. Every run carries its own state, timings, and per-step traces.",
	},
	state: {
		label: "State",
		definition:
			"The per-run record of every step's output, keyed by step id. Nodes never write it — the runner persists what a node returns, which is why steps stay replayable.",
	},
	forEach: {
		label: "forEach",
		definition:
			"Runs its body once per item of a collection. Its `as` and `asIndex` keys share the same namespace as step ids, so a name collision there is a real collision.",
	},
	subworkflow: {
		label: "Subworkflow",
		definition:
			"A workflow invoked as a step of another workflow. It gets its own run and its own state, and returns its result to the calling step.",
	},
	idempotencyKey: {
		label: "Idempotency key",
		definition:
			"A per-step key that makes a retry reuse the first attempt's result instead of doing the work twice. Give it a value derived from the input, never a constant.",
	},
	ephemeral: {
		label: "Ephemeral step",
		definition:
			"A step marked `ephemeral: true` gets no state slot. Nothing is persisted and its handle cannot be read downstream — use it for fire-and-forget effects.",
	},
} as const satisfies Record<string, { label: string; definition: string }>;

export type GlossaryTerm = keyof typeof BLOK_GLOSSARY;

type DefinitionTooltipProps = {
	term: GlossaryTerm;
	/** Defaults to the glossary label. Override to match the surrounding prose ("nodes", "steps"). */
	children?: ReactNode;
	side?: TooltipContentProps["side"];
	variant?: TooltipVariant;
	className?: string;
};

export function DefinitionTooltip({ term, children, side = "top", variant, className }: DefinitionTooltipProps) {
	const { label, definition } = BLOK_GLOSSARY[term];
	return (
		<SimpleTooltip
			side={side}
			variant={variant}
			// Wider than the default tooltip: these are two-sentence definitions,
			// and `max-w-xs` would column them into eight lines.
			className="max-w-sm"
			// `decoration-ink-faint` is a NON-text use of ink-faint (§3.1) — it is a
			// hairline under the word, not the word itself, which stays `text-ink`.
			buttonClassName={cn(
				"cursor-help underline decoration-ink-faint decoration-dashed underline-offset-4 transition-colors hover:decoration-ink-muted",
				className,
			)}
			button={children ?? label}
			content={
				<>
					<span className="mb-1 block font-semibold text-ink-strong">{label}</span>
					<span className="block text-ink-dimmed">{definition}</span>
				</>
			}
		/>
	);
}
