import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Header1, Header2, Header3 } from "@/components/primitives/Headers";
import { InlineCode } from "@/components/primitives/InlineCode";
import { Paragraph } from "@/components/primitives/Paragraph";
import { TextLink } from "@/components/primitives/TextLink";

export default function TypographyCatalog() {
	return (
		<CatalogPage
			title="Typography"
			description="Headings, body copy, links and inline code. Every one ships zero margin — pass `spacing` to opt into the variant's bottom margin."
		>
			{/*
			 * The Header1 specimen carries `aria-level={2}`: the page's real <h1> is
			 * CatalogPage's title, and a second level-1 heading would be a lie in the
			 * outline (and breaks `__tests__/catalog.test.tsx`, which is frozen).
			 * Style is unaffected — only the announced level is.
			 */}
			<Variant label="Headings — the tag is the API, so the heading outline stays honest">
				<div className="flex flex-col gap-3">
					<Header1 aria-level={2}>Header1 · page title</Header1>
					<Header2>Header2 · section</Header2>
					<Header3>Header3 · subsection</Header3>
				</div>
			</Variant>

			<Variant label="Heading tones">
				<div className="flex flex-col gap-3">
					<Header2 tone="strong">tone=&quot;strong&quot; (default)</Header2>
					<Header2 tone="dimmed">tone=&quot;dimmed&quot;</Header2>
				</div>
			</Variant>

			<Variant label="Paragraph sizes">
				<div className="flex flex-col gap-3">
					<Paragraph variant="base">base · 16px — long-form copy, empty states.</Paragraph>
					<Paragraph variant="small">small · 14px — the Studio default.</Paragraph>
					<Paragraph variant="extra-small">extra-small · 12px — table captions, metadata.</Paragraph>
				</div>
			</Variant>

			<Variant label="Paragraph tones — every one AA on all five surfaces">
				<div className="flex flex-col gap-3">
					<Paragraph tone="strong">tone=&quot;strong&quot; — ink-strong</Paragraph>
					<Paragraph tone="ink">tone=&quot;ink&quot; (default) — ink</Paragraph>
					<Paragraph tone="dimmed">tone=&quot;dimmed&quot; — ink-dimmed</Paragraph>
					<Paragraph tone="muted">
						tone=&quot;muted&quot; — ink-muted, the faintest ink that still holds words
					</Paragraph>
				</div>
			</Variant>

			<Variant label="Spacing — opt-in, off by default">
				<div className="flex flex-col">
					<Paragraph variant="base">No spacing: these two lines sit flush.</Paragraph>
					<Paragraph variant="base">No spacing: these two lines sit flush.</Paragraph>
					<Paragraph variant="base" spacing>
						spacing: adds the variant&apos;s mb-3.
					</Paragraph>
					<Paragraph variant="base" spacing>
						spacing: adds the variant&apos;s mb-3.
					</Paragraph>
				</div>
			</Variant>

			<Variant label="TextLink — internal routes via TanStack Link, external via a plain anchor">
				<div className="flex flex-col gap-3">
					<Paragraph>
						Internal, primary: <TextLink href="/runs">go to Runs</TextLink> — router navigation, no page reload.
					</Paragraph>
					<Paragraph>
						Internal, secondary:{" "}
						<TextLink href="/workflows" variant="secondary">
							go to Workflows
						</TextLink>
					</Paragraph>
					<Paragraph>
						External, primary: <TextLink href="https://blok.dev">blok.dev</TextLink> — new tab, rel=&quot;noopener
						noreferrer&quot;, icon affordance.
					</Paragraph>
					<Paragraph>
						External, secondary:{" "}
						<TextLink href="https://github.com/well-prado/blok" variant="secondary">
							the repo
						</TextLink>
					</Paragraph>
					<Paragraph variant="extra-small">
						A link inherits the size of the text around it: <TextLink href="/logs">this one is 12px</TextLink>.
					</Paragraph>
				</div>
			</Variant>

			<Variant label="Focus — tab through these; the ring is the one focus treatment">
				<div className="flex flex-wrap items-center gap-4">
					<TextLink href="/runs">Internal link</TextLink>
					<TextLink href="https://blok.dev">External link</TextLink>
					<TextLink href="mailto:hi@blok.dev" variant="secondary">
						mailto (treated as external)
					</TextLink>
				</div>
			</Variant>

			<Variant label="InlineCode">
				<div className="flex flex-col gap-3">
					<Paragraph variant="base">
						base · <InlineCode variant="base">ctx.state.validate</InlineCode>
					</Paragraph>
					<Paragraph variant="small">
						small · <InlineCode>run_01H8Z3K9</InlineCode>
					</Paragraph>
					<Paragraph variant="extra-small">
						extra-small · <InlineCode variant="extra-small">BLOK_ENV=production</InlineCode>
					</Paragraph>
				</div>
			</Variant>
		</CatalogPage>
	);
}
