import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Header1, Header2, Header3 } from "@/components/primitives/Headers";
import { InlineCode } from "@/components/primitives/InlineCode";
import { Paragraph } from "@/components/primitives/Paragraph";
import { Text } from "@/components/primitives/Text";
import { TextLink } from "@/components/primitives/TextLink";

export default function TypographyCatalog() {
	return (
		<CatalogPage
			title="Typography"
			description="Headings, body copy, links and inline code. Scale is `size` (§2.4a's text ladder), color is `ink` — never `variant`, never `tone` (§2.10). Every one ships zero margin: pass `spacing` to opt into the size's bottom margin."
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

			<Variant label="Heading ink — the text-color axis (§2.10), not tone">
				<div className="flex flex-col gap-3">
					<Header2 ink="strong">ink=&quot;strong&quot; (default)</Header2>
					<Header2 ink="dimmed">ink=&quot;dimmed&quot;</Header2>
				</div>
			</Variant>

			<Variant label="Paragraph sizes — §2.4a's text ladder">
				<div className="flex flex-col gap-3">
					<Paragraph size="lg">lg · 16px — long-form copy, empty states.</Paragraph>
					<Paragraph size="md">md · 14px — the Studio default.</Paragraph>
					<Paragraph size="sm">sm · 12px — table captions, metadata.</Paragraph>
				</div>
			</Variant>

			<Variant label="Paragraph ink — every one AA on all five surfaces">
				<div className="flex flex-col gap-3">
					<Paragraph ink="strong">ink=&quot;strong&quot; — ink-strong</Paragraph>
					<Paragraph ink="default">ink=&quot;default&quot; (default) — ink</Paragraph>
					<Paragraph ink="dimmed">ink=&quot;dimmed&quot; — ink-dimmed</Paragraph>
					<Paragraph ink="muted">ink=&quot;muted&quot; — ink-muted, the faintest ink that still holds words</Paragraph>
				</div>
			</Variant>

			<Variant label="Spacing — opt-in, off by default">
				<div className="flex flex-col">
					<Paragraph size="lg">No spacing: these two lines sit flush.</Paragraph>
					<Paragraph size="lg">No spacing: these two lines sit flush.</Paragraph>
					<Paragraph size="lg" spacing>
						spacing: adds the size&apos;s mb-3.
					</Paragraph>
					<Paragraph size="lg" spacing>
						spacing: adds the size&apos;s mb-3.
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
					<Paragraph size="sm">
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

			{/*
			 * `Text` was assigned to E1-T4 by CONVENTIONS §12.1 and never shipped;
			 * E2-T1 built it because table cells need mono and tabular numerals
			 * (§2.17, and the §12.1 correction). It is `Paragraph` with a <span>
			 * and two orthogonal booleans.
			 */}
			<Variant label="Text — mono and numeric, two independent flags">
				<div className="flex flex-col gap-3">
					<Paragraph size="sm" ink="dimmed">
						An id is mono without numeric; a right-aligned count is numeric without mono; a duration is usually both.
					</Paragraph>
					<Text mono>mono · run_01H8Z3K9WQ4M7RXF</Text>
					<Text numeric>numeric · 1,204 runs — tabular-nums keeps a column of these aligned</Text>
					<Text mono numeric>
						mono numeric · 1.24s
					</Text>
					<Text>neither · plain inline text on the §2.4a ladder</Text>
					<div className="flex flex-col">
						<Text numeric>11111</Text>
						<Text numeric>99999</Text>
						<Text>11111</Text>
						<Text>99999</Text>
					</div>
				</div>
			</Variant>

			<Variant label="Text sizes and ink — the same two axes as Paragraph, no variant, no tone">
				<div className="flex flex-col gap-3">
					<Text size="lg">size=&quot;lg&quot; · 16px</Text>
					<Text size="md">size=&quot;md&quot; (default) · 14px</Text>
					<Text size="sm">size=&quot;sm&quot; · 12px</Text>
					<Text ink="strong">ink=&quot;strong&quot;</Text>
					<Text ink="default">ink=&quot;default&quot; (default)</Text>
					<Text ink="dimmed">ink=&quot;dimmed&quot;</Text>
					<Text ink="muted">ink=&quot;muted&quot;</Text>
				</div>
			</Variant>

			<Variant label="InlineCode">
				<div className="flex flex-col gap-3">
					<Paragraph size="lg">
						lg · <InlineCode size="lg">ctx.state.validate</InlineCode>
					</Paragraph>
					<Paragraph size="md">
						md · <InlineCode>run_01H8Z3K9</InlineCode>
					</Paragraph>
					<Paragraph size="sm">
						sm · <InlineCode size="sm">BLOK_ENV=production</InlineCode>
					</Paragraph>
				</div>
			</Variant>
		</CatalogPage>
	);
}
