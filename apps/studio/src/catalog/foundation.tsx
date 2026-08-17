import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { STATUS_COLORS, STATUS_DOT_COLORS, STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";

// Class names are written out literally on purpose — Tailwind scans source text,
// so a computed `bg-${name}` would emit nothing and every swatch would be blank.

const surfaces = [
	{ token: "canvas", className: "bg-canvas" },
	{ token: "raised", className: "bg-raised" },
	{ token: "overlay", className: "bg-overlay" },
	{ token: "hover", className: "bg-hover" },
	{ token: "control", className: "bg-control" },
] as const;

const inks = [
	{ token: "ink-strong", className: "text-ink-strong" },
	{ token: "ink", className: "text-ink" },
	{ token: "ink-dimmed", className: "text-ink-dimmed" },
	{ token: "ink-muted", className: "text-ink-muted" },
	{ token: "ink-faint", className: "text-ink-faint" },
] as const;

const lines = [
	{ token: "line", className: "border-line" },
	{ token: "line-strong", className: "border-line-strong" },
	{ token: "line-bright", className: "border-line-bright" },
] as const;

const accents = [
	{ token: "accent", className: "bg-accent text-on-accent" },
	{ token: "accent-hover", className: "bg-accent-hover text-on-accent" },
	{ token: "focus-ring", className: "bg-focus-ring text-on-accent" },
] as const;

const logs = [
	{ token: "log-debug", className: "bg-log-debug" },
	{ token: "log-info", className: "bg-log-info" },
	{ token: "log-warn", className: "bg-log-warn" },
	{ token: "log-error", className: "bg-log-error" },
] as const;

const statuses = Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[];

function Swatch({ token, className }: { token: string; className: string }) {
	return (
		<div className="flex w-32 flex-col gap-1.5">
			<div className={cn("h-12 rounded-md border border-line", className)} />
			<code className="font-mono text-[10px] text-ink-muted">{token}</code>
		</div>
	);
}

export default function FoundationCatalog() {
	return (
		<CatalogPage
			title="Foundation"
			description="The complete token vocabulary. If a color you need is not on this page, it does not exist — report the gap instead of inventing a hex."
		>
			<Variant label="Surfaces">
				{surfaces.map((s) => (
					<Swatch key={s.token} {...s} />
				))}
			</Variant>

			<Variant label="Ink">
				{inks.map(({ token, className }) => (
					<div key={token} className="flex w-32 flex-col gap-1.5">
						<p className={cn("text-sm", className)}>Aa Blok 42ms</p>
						<code className="font-mono text-[10px] text-ink-muted">{token}</code>
					</div>
				))}
			</Variant>

			<Variant label="Lines">
				{lines.map(({ token, className }) => (
					<div key={token} className="flex w-32 flex-col gap-1.5">
						<div className={cn("h-12 rounded-md border bg-raised", className)} />
						<code className="font-mono text-[10px] text-ink-muted">{token}</code>
					</div>
				))}
			</Variant>

			<Variant label="Accent">
				{accents.map((a) => (
					<Swatch key={a.token} {...a} />
				))}
			</Variant>

			<Variant label="Status — swatch, chip and dot for all 14 statuses">
				{statuses.map((status) => (
					<div key={status} className="flex w-36 flex-col gap-1.5">
						<span className={cn("inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs", STATUS_COLORS[status])}>
							<span className={cn("h-2 w-2 rounded-full", STATUS_DOT_COLORS[status])} />
							{STATUS_LABELS[status]}
						</span>
						<code className="font-mono text-[10px] text-ink-muted">status-{status}</code>
					</div>
				))}
			</Variant>

			<Variant label="Log levels">
				{logs.map((l) => (
					<Swatch key={l.token} {...l} />
				))}
			</Variant>

			<Variant label="Focus — tab into these, the ring is inset by design">
				<button type="button" className="focus-ring rounded-md bg-control px-3 py-1.5 text-sm text-ink">
					Focusable control
				</button>
				<button
					type="button"
					className="focus-ring rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent"
				>
					Accent control
				</button>
			</Variant>

			<Variant label="Type">
				<p className="font-mono text-sm text-ink">font-mono · run_01HXYZ · 1284ms</p>
				<p className="font-display text-2xl italic text-ink-strong">font-display · 1.28s</p>
			</Variant>
		</CatalogPage>
	);
}
