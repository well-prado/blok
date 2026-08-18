import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { ClipboardField } from "@/components/primitives/ClipboardField";
import { CopyButton } from "@/components/primitives/CopyButton";
import { CopyableText } from "@/components/primitives/CopyableText";
import { MiddleTruncate } from "@/components/primitives/MiddleTruncate";

const RUN_ID = "run_d1f7dca71dbe8f3a2c4e";

export default function ClipboardCatalog() {
	return (
		<CatalogPage
			title="Clipboard"
			description="Copy affordances and id truncation. Every copy announces itself politely; a missing clipboard API (insecure context) lands in a visible failure state instead of doing nothing."
		>
			<Variant label="CopyButton — variants (md, icon-only)">
				<CopyButton value={RUN_ID} variant="minimal" />
				<CopyButton value={RUN_ID} variant="secondary" />
			</Variant>

			<Variant label="CopyButton — sizes (icon-only, square)">
				<CopyButton value={RUN_ID} variant="secondary" size="xs" />
				<CopyButton value={RUN_ID} variant="secondary" size="sm" />
				<CopyButton value={RUN_ID} variant="secondary" size="md" />
			</Variant>

			<Variant label="CopyButton — sizes (with a label)">
				<CopyButton value={RUN_ID} variant="secondary" size="xs">
					Copy id
				</CopyButton>
				<CopyButton value={RUN_ID} variant="secondary" size="sm">
					Copy id
				</CopyButton>
				<CopyButton value={RUN_ID} variant="secondary" size="md">
					Copy id
				</CopyButton>
				<CopyButton value={RUN_ID} variant="minimal" size="md">
					Copy id
				</CopyButton>
			</Variant>

			<Variant label="CopyButton — disabled">
				<CopyButton value={RUN_ID} variant="secondary" disabled />
				<CopyButton value={RUN_ID} variant="minimal" disabled />
				<CopyButton value={RUN_ID} variant="secondary" disabled>
					Copy id
				</CopyButton>
			</Variant>

			<Variant label="CopyButton — focus (tab into this row; the ring is inset)">
				<CopyButton value={RUN_ID} variant="secondary" />
				<CopyButton value={RUN_ID} variant="minimal">
					Tab here next
				</CopyButton>
			</Variant>

			<Variant label="CopyableText — the label IS the button">
				<CopyableText value={RUN_ID} />
				<CopyableText value="Copy this sentence" mono={false} />
				<CopyableText value="run_d1f7…3a2c4e" copyValue={RUN_ID} />
				<CopyableText value={RUN_ID} disabled />
			</Variant>

			<Variant label="ClipboardField — sizes">
				<div className="w-full space-y-3">
					<ClipboardField value={RUN_ID} size="sm" label="Run id (small)" />
					<ClipboardField value={RUN_ID} size="md" label="Run id (medium)" />
					<ClipboardField value="blok_sk_9f2b1c" size="md" label="API key" fullWidth={false} />
				</div>
			</Variant>

			<Variant label="ClipboardField — overflowing value fades at the right edge">
				<div className="w-72">
					<ClipboardField
						value="postgres://blok:hunter2@db.internal.example.com:5432/blok_production?sslmode=require"
						label="Connection string"
					/>
				</div>
			</Variant>

			<Variant label="MiddleTruncate — both ends of an id survive">
				<div className="space-y-1 text-sm text-ink-dimmed">
					<div>
						<MiddleTruncate text={RUN_ID} maxLength={12} />
					</div>
					<div>
						<MiddleTruncate text={RUN_ID} maxLength={18} />
					</div>
					<div>
						<MiddleTruncate text={RUN_ID} />
					</div>
					<div>
						<MiddleTruncate text="run_short" />
					</div>
				</div>
			</Variant>
		</CatalogPage>
	);
}
