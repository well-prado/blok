import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type FieldsetProps = React.ComponentPropsWithRef<"fieldset"> & {
	/** Rendered as a real `<legend>`, which is what names the group for AT. */
	legend?: ReactNode;
};

/**
 * A real `<fieldset>`, not a styled `<div>`: it is what gives a set of radios a
 * group name, and it propagates `disabled` to every control inside it for free.
 */
export function Fieldset({ className, legend, children, ...props }: FieldsetProps) {
	return (
		<fieldset className={cn("flex min-w-0 flex-col gap-4 border-0 p-0", className)} {...props}>
			{legend && <legend className="text-sm font-medium text-ink">{legend}</legend>}
			{children}
		</fieldset>
	);
}
