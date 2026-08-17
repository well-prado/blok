import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Button, type ButtonSize, type ButtonVariant, LinkButton } from "@/components/primitives/Buttons";
import { useRouter } from "@tanstack/react-router";
import { ArrowRight, Play, Plus, Trash2 } from "lucide-react";

const allVariants: ButtonVariant[] = ["primary", "secondary", "minimal", "danger"];
const allSizes: ButtonSize[] = ["xs", "sm", "md", "lg"];

export default function ButtonsCatalog() {
	// `LinkButton` is a TanStack `Link`, so it needs a router in context — and the
	// frozen `__tests__/catalog.test.tsx` renders every catalog page bare, with no
	// `RouterProvider`. `warn: false` makes the lookup a plain context read instead
	// of a console warning, so the section renders in the app and is skipped in the
	// test. (Reported upward: CONVENTIONS §7 has no answer for a routed primitive.)
	const hasRouter = Boolean(useRouter({ warn: false }));

	return (
		<CatalogPage
			title="Buttons"
			description="Four variants × the four-row size ladder (CONVENTIONS §2.4), with icon slots, a loading state, and the shortcut hint rendered inside the button."
		>
			<Variant label="Variants">
				{allVariants.map((variant) => (
					<Button key={variant} variant={variant}>
						{variant}
					</Button>
				))}
			</Variant>

			{allVariants.map((variant) => (
				<Variant key={variant} label={`${variant} — sizes xs / sm / md / lg`}>
					{allSizes.map((size) => (
						<Button key={size} variant={variant} size={size} leadingIcon={<Play />}>
							Run {size}
						</Button>
					))}
				</Variant>
			))}

			<Variant label="Icon slots">
				<Button leadingIcon={<Plus />}>Leading</Button>
				<Button trailingIcon={<ArrowRight />}>Trailing</Button>
				<Button variant="danger" leadingIcon={<Trash2 />} trailingIcon={<ArrowRight />}>
					Both
				</Button>
			</Variant>

			<Variant label="Icon only — the row height becomes the width; aria-label is mandatory">
				{allSizes.map((size) => (
					<Button key={size} size={size} leadingIcon={<Play />} aria-label={`Run (${size})`} />
				))}
				<Button variant="primary" leadingIcon={<Plus />} aria-label="Add node" />
				<Button variant="minimal" leadingIcon={<Trash2 />} aria-label="Delete" />
			</Variant>

			<Variant label="Shortcut hint — decorative: Studio has no hotkey subsystem yet, so nothing is bound">
				{allVariants.map((variant) => (
					<Button key={variant} variant={variant} shortcut="⌘K">
						Search
					</Button>
				))}
				<Button size="lg" leadingIcon={<Play />} shortcut="R">
					Run workflow
				</Button>
			</Variant>

			<Variant label="Loading — the leading slot becomes a Spinner, and the button is disabled so it cannot submit twice">
				{allSizes.map((size) => (
					<Button key={size} size={size} isLoading>
						Deploying
					</Button>
				))}
				<Button variant="primary" isLoading>
					Deploying
				</Button>
			</Variant>

			<Variant label="Disabled">
				{allVariants.map((variant) => (
					<Button key={variant} variant={variant} disabled leadingIcon={<Play />}>
						{variant}
					</Button>
				))}
			</Variant>

			<Variant label="Focus — tab through these; the ring is inset by design">
				{allVariants.map((variant) => (
					<Button key={variant} variant={variant} shortcut="⏎">
						Focus me
					</Button>
				))}
			</Variant>

			{hasRouter && (
				<Variant label="LinkButton — a TanStack Link wearing the same chrome">
					<LinkButton to="/">Dashboard</LinkButton>
					<LinkButton to="/metrics" variant="primary" trailingIcon={<ArrowRight />}>
						Metrics
					</LinkButton>
					<LinkButton to="/runs" variant="minimal" size="sm" leadingIcon={<Play />}>
						Runs
					</LinkButton>
				</Variant>
			)}
		</CatalogPage>
	);
}
