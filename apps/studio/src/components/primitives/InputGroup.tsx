import { cn } from "@/lib/utils";

/**
 * Stacks one field's label, control, hint and error. Layout only — it does not
 * generate ids or wire `aria-describedby`, because a wrapper that silently
 * clones props onto unknown children is the kind of magic that breaks the
 * moment a control is nested one level deeper. The catalog page shows the
 * explicit wiring, which is three attributes.
 */
export function InputGroup({ className, ...props }: React.ComponentPropsWithRef<"div">) {
	return <div className={cn("grid w-full items-center gap-1.5", className)} {...props} />;
}
