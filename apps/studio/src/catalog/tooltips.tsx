import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { BLOK_GLOSSARY, DefinitionTooltip, type GlossaryTerm } from "@/components/primitives/DefinitionTooltip";
import { InfoIconTooltip, SimpleTooltip } from "@/components/primitives/Tooltip";

const sides = ["top", "right", "bottom", "left"] as const;
const iconSizes = ["xs", "sm", "md", "lg"] as const;
const terms = Object.keys(BLOK_GLOSSARY) as GlossaryTerm[];

export default function TooltipsCatalog() {
	return (
		<CatalogPage
			title="Tooltips"
			description="Radix-backed tooltips. Every one on this page opens on Tab as well as on hover, and closes on Escape — put your mouse away and try it."
		>
			<Variant label="Variants">
				<SimpleTooltip button="default" content="Sits on the canvas. The everyday tooltip." />
				<SimpleTooltip
					button="contrast"
					variant="contrast"
					content="For tooltips over a raised or overlay surface, where the default would disappear into its host."
				/>
			</Variant>

			<Variant label="Sides — collision-aware, Radix flips them near a viewport edge">
				{sides.map((side) => (
					<SimpleTooltip key={side} button={side} side={side} content={`Anchored to the ${side}.`} />
				))}
			</Variant>

			<Variant label="asChild — wrap a control you already styled">
				<SimpleTooltip
					asChild
					content="asChild hands the trigger behaviour to your element instead of adding a button around it."
					button={
						<button type="button" className="focus-ring rounded-md bg-control px-3 py-1.5 text-sm text-ink">
							Existing button
						</button>
					}
				/>
				<SimpleTooltip
					asChild
					side="right"
					content="Why this is unavailable. A natively `disabled` button fires no pointer or focus events, so a tooltip on one never opens — CONVENTIONS §2.6's aria-disabled form is what keeps the explanation reachable."
					button={
						<button
							type="button"
							aria-disabled="true"
							onClick={(e) => e.preventDefault()}
							className="focus-ring rounded-md bg-control px-3 py-1.5 text-sm text-ink opacity-50"
						>
							Disabled control
						</button>
					}
				/>
			</Variant>

			<Variant label="InfoIconTooltip — the glyph size ladder (§2.4 icon column)">
				{iconSizes.map((size) => (
					<span key={size} className="inline-flex items-center gap-1.5 text-sm text-ink">
						{size}
						<InfoIconTooltip
							size={size}
							label={`About ${size}`}
							content="Icon-only triggers carry an aria-label; the glyph itself is aria-hidden."
						/>
					</span>
				))}
			</Variant>

			<Variant label="InfoIconTooltip in a form row">
				<span className="inline-flex items-center gap-1.5 text-sm text-ink">
					Idempotency key
					<InfoIconTooltip
						label="About idempotency keys"
						content={BLOK_GLOSSARY.idempotencyKey.definition}
						side="right"
					/>
				</span>
			</Variant>

			<Variant label="DefinitionTooltip — the whole Blok glossary, seeded with real terms">
				{terms.map((term) => (
					<DefinitionTooltip key={term} term={term} />
				))}
			</Variant>

			<Variant label="DefinitionTooltip in prose — the point of the primitive">
				<p className="max-w-prose text-sm text-ink-dimmed">
					A{" "}
					<DefinitionTooltip term="workflow" className="text-ink">
						workflow
					</DefinitionTooltip>{" "}
					is a sequence of{" "}
					<DefinitionTooltip term="step" className="text-ink">
						steps
					</DefinitionTooltip>
					, each one an invocation of a{" "}
					<DefinitionTooltip term="node" className="text-ink">
						node
					</DefinitionTooltip>
					. Starting it produces a{" "}
					<DefinitionTooltip term="run" className="text-ink">
						run
					</DefinitionTooltip>
					, whose{" "}
					<DefinitionTooltip term="state" className="text-ink">
						state
					</DefinitionTooltip>{" "}
					records what every step returned — unless the step was{" "}
					<DefinitionTooltip term="ephemeral" className="text-ink">
						ephemeral
					</DefinitionTooltip>
					.
				</p>
			</Variant>

			<Variant label="Controlled — open without hover or focus">
				<SimpleTooltip open button="Always open" content="Driven by the `open` prop." side="bottom" />
			</Variant>
		</CatalogPage>
	);
}
