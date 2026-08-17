import { CatalogPage, Variant } from "@/components/catalog/CatalogPage";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Fieldset } from "@/components/primitives/Fieldset";
import { FormButtons } from "@/components/primitives/FormButtons";
import { FormError } from "@/components/primitives/FormError";
import { Hint } from "@/components/primitives/Hint";
import { Input } from "@/components/primitives/Input";
import { InputGroup } from "@/components/primitives/InputGroup";
import { Label } from "@/components/primitives/Label";
import { RadioButton } from "@/components/primitives/RadioButton";
import { SegmentedControl } from "@/components/primitives/SegmentedControl";
import { Select } from "@/components/primitives/Select";
import { Switch } from "@/components/primitives/Switch";
import { TextArea } from "@/components/primitives/TextArea";

// Presentational only — no data fetching, no `@/lib/api` (§7.2).

const SIZES = ["xs", "sm", "md", "lg"] as const;
const SWITCH_SIZES = ["sm", "md", "lg"] as const;

const VIEW_OPTIONS = [
	{ label: "Runs", value: "runs" },
	{ label: "Logs", value: "logs" },
	{ label: "Metrics", value: "metrics" },
];

function EnvOptions() {
	return (
		<>
			<option value="dev">Development</option>
			<option value="staging">Staging</option>
			<option value="prod">Production</option>
		</>
	);
}

/** One labelled column, so a row of four sizes reads as a ladder. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex w-44 flex-col gap-1.5">
			{children}
			<code className="font-mono text-[10px] text-ink-muted">{label}</code>
		</div>
	);
}

export default function FormsCatalog() {
	return (
		<CatalogPage
			title="Forms"
			description="Every form control, at every size, in every state. Each control here is a real native element under the styling — the only Radix package this page uses is Switch."
		>
			<Variant label="Input — sizes">
				{SIZES.map((size) => (
					<Row key={size} label={size}>
						<Input size={size} aria-label={`Input ${size}`} placeholder="workflow-name" />
					</Row>
				))}
			</Variant>

			<Variant label="Input — states (tab through these; the focus ring is inset)">
				<Row label="default">
					<Input aria-label="Default input" defaultValue="order-processor" />
				</Row>
				<Row label="placeholder">
					<Input aria-label="Empty input" placeholder="workflow-name" />
				</Row>
				<Row label="aria-invalid">
					<Input aria-label="Invalid input" aria-invalid="true" defaultValue="Order Processor!" />
				</Row>
				<Row label="disabled">
					<Input aria-label="Disabled input" disabled defaultValue="order-processor" />
				</Row>
				<Row label="readOnly">
					<Input aria-label="Read-only input" readOnly defaultValue="order-processor" />
				</Row>
			</Variant>

			<Variant label="TextArea — sizes keep the row's padding-x and text, and floor the height">
				{SIZES.map((size) => (
					<Row key={size} label={size}>
						<TextArea size={size} rows={2} aria-label={`TextArea ${size}`} placeholder="Describe this workflow" />
					</Row>
				))}
				<Row label="disabled">
					<TextArea rows={2} disabled aria-label="Disabled textarea" defaultValue="Locked" />
				</Row>
				<Row label="aria-invalid">
					<TextArea rows={2} aria-invalid="true" aria-label="Invalid textarea" defaultValue="Too long…" />
				</Row>
			</Variant>

			<Variant label="Select — native, so typeahead and the platform option list come free">
				{SIZES.map((size) => (
					<Row key={size} label={size}>
						<Select size={size} aria-label={`Select ${size}`} defaultValue="dev">
							<EnvOptions />
						</Select>
					</Row>
				))}
				<Row label="disabled">
					<Select disabled aria-label="Disabled select" defaultValue="dev">
						<EnvOptions />
					</Select>
				</Row>
				<Row label="aria-invalid">
					<Select aria-invalid="true" aria-label="Invalid select" defaultValue="dev">
						<EnvOptions />
					</Select>
				</Row>
			</Variant>

			<Variant label="Label">
				{SIZES.map((size) => (
					<Row key={size} label={size}>
						<Label size={size}>Workflow name</Label>
					</Row>
				))}
				<Row label="required={false}">
					<Label required={false}>Description</Label>
				</Row>
			</Variant>

			<Variant label="Hint and FormError">
				<Row label="Hint">
					<Hint>Lowercase letters, numbers and dashes.</Hint>
				</Row>
				<Row label="FormError">
					<FormError>A workflow with this name already exists.</FormError>
				</Row>
			</Variant>

			<Variant label="InputGroup — label + control + hint, wired by hand in three attributes">
				<InputGroup className="max-w-sm">
					<Label htmlFor="catalog-slug">Slug</Label>
					<Input id="catalog-slug" aria-describedby="catalog-slug-hint" placeholder="order-processor" />
					<Hint id="catalog-slug-hint">Used in the workflow's URL.</Hint>
				</InputGroup>
				<InputGroup className="max-w-sm">
					<Label htmlFor="catalog-name">Name</Label>
					<Input
						id="catalog-name"
						aria-invalid="true"
						aria-describedby="catalog-name-error"
						defaultValue="Order Processor!"
					/>
					<FormError id="catalog-name-error">Only letters, numbers and dashes are allowed.</FormError>
				</InputGroup>
			</Variant>

			<Variant label="Checkbox — sizes">
				{SIZES.map((size) => (
					<Checkbox key={size} size={size} label={`Retry on failure (${size})`} defaultChecked />
				))}
			</Variant>

			<Variant label="Checkbox — states">
				<Checkbox label="Unchecked" />
				<Checkbox label="Checked" defaultChecked />
				<Checkbox label="Disabled" disabled />
				<Checkbox label="Disabled + checked" disabled defaultChecked />
				<Checkbox label="With description" description="Re-runs the step up to 3 times." defaultChecked />
			</Variant>

			<Variant label="RadioButton — one fieldset per group; arrow keys cycle, courtesy of the browser">
				<Fieldset legend="Environment" className="gap-2">
					<RadioButton name="catalog-env" value="dev" label="Development" defaultChecked />
					<RadioButton name="catalog-env" value="staging" label="Staging" description="Deploy previews land here." />
					<RadioButton name="catalog-env" value="prod" label="Production" />
				</Fieldset>
				<Fieldset legend="Disabled group" disabled className="gap-2">
					<RadioButton name="catalog-env-off" value="a" label="Option A" defaultChecked />
					<RadioButton name="catalog-env-off" value="b" label="Option B" />
				</Fieldset>
			</Variant>

			<Variant label="RadioButton — sizes">
				{SIZES.map((size) => (
					<RadioButton key={size} name={`catalog-radio-${size}`} value={size} label={size} size={size} defaultChecked />
				))}
			</Variant>

			<Variant label="Switch — sizes (Radix); label sits either side">
				{SWITCH_SIZES.map((size) => (
					<Switch key={size} size={size} label={`Tracing (${size})`} defaultChecked />
				))}
				<Switch label="Label on the left" labelPosition="left" />
			</Variant>

			<Variant label="Switch — states">
				<Switch label="Off" />
				<Switch label="On" defaultChecked />
				<Switch label="Disabled" disabled />
				<Switch label="Disabled + on" disabled defaultChecked />
			</Variant>

			<Variant label="SegmentedControl — sizes">
				{SIZES.map((size) => (
					<SegmentedControl
						key={size}
						size={size}
						name={`catalog-view-${size}`}
						label={`View (${size})`}
						options={VIEW_OPTIONS}
						defaultValue="runs"
					/>
				))}
			</Variant>

			<Variant label="SegmentedControl — states">
				<SegmentedControl name="catalog-view-full" label="Full width" options={VIEW_OPTIONS} defaultValue="logs" />
				<SegmentedControl
					name="catalog-view-off"
					label="Disabled view"
					options={VIEW_OPTIONS}
					defaultValue="runs"
					disabled
				/>
			</Variant>

			<Variant label="Fieldset + FormButtons — a whole form">
				<form className="w-full max-w-md" onSubmit={(e) => e.preventDefault()}>
					<Fieldset legend="New workflow">
						<InputGroup>
							<Label htmlFor="catalog-form-name">Name</Label>
							<Input id="catalog-form-name" placeholder="order-processor" />
						</InputGroup>
						<InputGroup>
							<Label htmlFor="catalog-form-env">Environment</Label>
							<Select id="catalog-form-env" defaultValue="dev">
								<EnvOptions />
							</Select>
						</InputGroup>
						<InputGroup>
							<Label htmlFor="catalog-form-notes" required={false}>
								Notes
							</Label>
							<TextArea id="catalog-form-notes" rows={3} placeholder="What does this workflow do?" />
						</InputGroup>
						<Checkbox label="Deploy immediately" />
						<FormButtons
							cancelButton={
								<button
									type="button"
									className="focus-ring h-8 rounded-md border border-line-strong bg-control px-3 text-sm text-ink"
								>
									Cancel
								</button>
							}
							confirmButton={
								<button
									type="submit"
									className="focus-ring h-8 rounded-md bg-accent px-3 text-sm font-semibold text-on-accent"
								>
									Create workflow
								</button>
							}
						/>
					</Fieldset>
				</form>
			</Variant>
		</CatalogPage>
	);
}
