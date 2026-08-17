import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type FormButtonsProps = Omit<React.ComponentPropsWithRef<"div">, "children"> & {
	cancelButton?: ReactNode;
	confirmButton?: ReactNode;
};

/**
 * The action row at the foot of a form: cancel on the left, confirm on the
 * right, separated from the fields by a rule.
 *
 * Takes the buttons as nodes rather than rendering them, because T3 owns
 * `Button` and cross-importing another wave-B primitive is banned (§12.4).
 */
export function FormButtons({ className, cancelButton, confirmButton, ...props }: FormButtonsProps) {
	return (
		<div
			className={cn("flex w-full items-center justify-between gap-2 border-t border-line pt-4", className)}
			{...props}
		>
			{cancelButton ?? <div />}
			{confirmButton}
		</div>
	);
}
