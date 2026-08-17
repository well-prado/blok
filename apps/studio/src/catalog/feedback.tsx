import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Badge, StatusBadge } from "@/components/primitives/Badge";
import { Callout } from "@/components/primitives/Callout";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Toast } from "@/components/primitives/Toast";
import { STATUS_LABELS } from "@/lib/constants";
import { Inbox } from "lucide-react";

const statuses = Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[];

export default function FeedbackCatalog() {
	return (
		<CatalogPage
			title="Feedback"
			description="Badges, callouts, toasts and empty states. Statuses read their colors from STATUS_COLORS / STATUS_DOT_COLORS, which already carry the fill/ink role split."
		>
			<Variant label="Badge — variants">
				<Badge>default</Badge>
				<Badge variant="accent">accent</Badge>
				<Badge variant="outline">outline</Badge>
			</Variant>

			<Variant label="Badge — sizes (ladder rows xs / sm / md; lg omitted)">
				<Badge size="xs">xs</Badge>
				<Badge size="sm">sm</Badge>
				<Badge size="md">md</Badge>
			</Variant>

			<Variant label="StatusBadge — all 14 statuses (running pulses)">
				{statuses.map((status) => (
					<StatusBadge key={status} status={status} />
				))}
			</Variant>

			<Variant label="Callout — variants">
				<div className="flex w-full flex-col gap-3">
					<Callout variant="info">Runs older than 30 days are archived.</Callout>
					<Callout variant="success">Deployment finished in 4.2s.</Callout>
					<Callout variant="warning">This workflow has no retry policy.</Callout>
					<Callout variant="error">3 steps failed on the last run.</Callout>
					<Callout variant="neutral">Nothing has run in this environment yet.</Callout>
				</div>
			</Variant>

			<Variant label="Callout — with a title, and dismissible (tab to the ✕ for the focus ring)">
				<div className="flex w-full flex-col gap-3">
					<Callout variant="warning" title="Rate limited">
						The HTTP trigger returned 429 twice. The next attempt is in 30s.
					</Callout>
					<Callout variant="info" title="New runtime available" onDismiss={() => {}}>
						Python 3.12 is now supported for node execution.
					</Callout>
					<Callout variant="error" onDismiss={() => {}}>
						Could not reach the scheduler.
					</Callout>
				</div>
			</Variant>

			<Variant label="Toast — variants, plain / actionable / dismissible (tab through them)">
				<div className="flex w-full max-w-sm flex-col gap-2">
					<Toast variant="success" title="Run finished" message="wf-orders · 1.24s" />
					<Toast variant="error" title="Run failed" message="validate-order threw" onDismiss={() => {}} />
					<Toast variant="warning" title="Queue backing up" message="428 pending" onDismiss={() => {}} />
					<Toast
						variant="info"
						title="Run started"
						message="wf-orders · click to open"
						onSelect={() => {}}
						onDismiss={() => {}}
					/>
				</div>
			</Variant>

			<Variant label="EmptyState — centered, with a teaching snippet and a doc link">
				<EmptyState
					icon={<Inbox className="h-8 w-8" />}
					title="No runs yet"
					description="Trigger this workflow and its runs will show up here."
					snippets={[{ lang: "curl · http", code: 'curl -X POST localhost:4000/orders -d \'{"id":"o-1"}\'' }]}
					docLink={{ href: "https://blok.build/docs", label: "Triggering workflows" }}
				/>
			</Variant>

			<Variant label="EmptyState — left aligned, no snippets">
				<EmptyState
					align="left"
					icon={<Inbox className="h-6 w-6" />}
					title="No saved filters"
					description="Save a filter from the runs table to pin it here."
				/>
			</Variant>
		</CatalogPage>
	);
}
