import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Spinner } from "@/components/primitives/Spinner";
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

// Written out literally, same reason as everything else on this page. The row
// values are the normative ladder in `_design/CONVENTIONS.md` §2.4.
const sizeLadder = [
	{ size: "xs", box: "h-6 px-2 text-xs", spinner: "xs" },
	{ size: "sm", box: "h-7 px-2.5 text-xs", spinner: "sm" },
	{ size: "md", box: "h-8 px-3 text-sm", spinner: "md" },
	{ size: "lg", box: "h-9 px-4 text-sm", spinner: "lg" },
] as const;

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

			<Variant label="Ink — text roles, every one AA (4.5:1) on all five surfaces">
				{inks.map(({ token, className }) => (
					<div key={token} className="flex w-32 flex-col gap-1.5">
						<p className={cn("text-sm", className)}>Aa Blok 42ms</p>
						<code className="font-mono text-[10px] text-ink-muted">{token}</code>
					</div>
				))}
			</Variant>

			<Variant label="ink-faint — NOT a text role (3:1 only): rules, disabled glyphs, gridlines">
				<div className="flex w-32 flex-col gap-1.5">
					<div className="h-12 rounded-md border-2 border-ink-faint" />
					<code className="font-mono text-[10px] text-ink-muted">ink-faint</code>
				</div>
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

			<Variant label="Status — two roles per status: the FILL (dot) and the INK (label)">
				{statuses.map((status) => (
					<div key={status} className="flex w-36 flex-col gap-1.5">
						<span
							className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs", STATUS_COLORS[status])}
						>
							<span className={cn("h-2 w-2 rounded-full", STATUS_DOT_COLORS[status])} />
							{STATUS_LABELS[status]}
						</span>
						<code className="font-mono text-[10px] text-ink-muted">status-{status}[-ink]</code>
					</div>
				))}
			</Variant>

			<Variant label="Log levels">
				{logs.map((l) => (
					<Swatch key={l.token} {...l} />
				))}
			</Variant>

			<Variant label="Size ladder — every sized primitive uses these four rows (CONVENTIONS §2.4)">
				{sizeLadder.map(({ size, box, spinner }) => (
					<div key={size} className="flex flex-col items-center gap-1.5">
						<div
							className={cn("inline-flex items-center gap-2 rounded-md border border-line bg-control text-ink", box)}
						>
							<Spinner size={spinner} label={null} />
							Aa
						</div>
						<code className="font-mono text-[10px] text-ink-muted">{size}</code>
					</div>
				))}
			</Variant>

			<Variant label="Focus + disabled — tab into these; the ring is inset by design">
				<button type="button" className="focus-ring rounded-md bg-control px-3 py-1.5 text-sm text-ink">
					Focusable control
				</button>
				<button
					type="button"
					className="focus-ring rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent"
				>
					Accent control
				</button>
				<button
					type="button"
					disabled
					className="focus-ring rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent disabled:pointer-events-none disabled:opacity-50"
				>
					Disabled
				</button>
			</Variant>

			<Variant label="Type">
				<p className="font-mono text-sm text-ink">font-mono · run_01HXYZ · 1284ms</p>
				<p className="font-display text-2xl italic text-ink-strong">font-display · 1.28s</p>
			</Variant>
		</CatalogPage>
	);
}
