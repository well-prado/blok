import { cn } from "@/lib/utils";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";

/**
 * A two-pane splitter. `react-resizable-panels` is NOT installed and §0.1
 * closes the dependency list, so this is the minimum honest implementation:
 * pointer drag plus a real keyboard contract on a focusable separator handle.
 *
 * WHAT IT DOES: two panes, one handle, percentage sizing, horizontal or
 * vertical, `min`/`max` clamping, uncontrolled (`defaultSize`) or controlled
 * (`size` + `onSizeChange`). Keyboard: Arrow keys move 2%, Shift+Arrow 10%,
 * Home/End jump to `min`/`max`.
 *
 * WHAT IT DOES NOT DO, deliberately — the ceilings, and what to reach for if
 * one of them starts to hurt:
 *   - exactly TWO panes. Three-way splits need a group/registry model;
 *     nest two `Resizable`s, or take the dependency then.
 *   - no persistence. Lift `size` into the caller's store; there is no
 *     localStorage here.
 *   - no collapse-to-zero, no snap points, no double-click-to-reset.
 *   - percentages only, so a pane cannot be pinned to a px width.
 *   - pointer capture only: works with mouse, pen and touch, but there is no
 *     touch-specific drag affordance beyond the 8px hit area.
 */
const axes = {
	horizontal: {
		root: "flex-row",
		handle: "h-auto w-1.5 cursor-col-resize",
		decrease: "ArrowLeft",
		increase: "ArrowRight",
	},
	vertical: {
		root: "flex-col",
		handle: "h-1.5 w-auto cursor-row-resize",
		decrease: "ArrowUp",
		increase: "ArrowDown",
	},
} as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type ResizableProps = Omit<React.ComponentPropsWithRef<"div">, "children" | "onChange"> & {
	first: ReactNode;
	second: ReactNode;
	direction?: keyof typeof axes;
	/** Percentage of the first pane, uncontrolled. */
	defaultSize?: number;
	/** Percentage of the first pane, controlled. Pass with `onSizeChange`. */
	size?: number;
	onSizeChange?: (size: number) => void;
	min?: number;
	max?: number;
	/** Accessible name of the separator. */
	label?: string;
};

export function Resizable({
	className,
	first,
	second,
	direction = "horizontal",
	defaultSize = 50,
	size,
	onSizeChange,
	min = 10,
	max = 90,
	label = "Resize panes",
	...props
}: ResizableProps) {
	const axis = axes[direction];
	const rootRef = useRef<HTMLDivElement>(null);
	const [uncontrolled, setUncontrolled] = useState(clamp(defaultSize, min, max));
	const current = clamp(size ?? uncontrolled, min, max);
	const firstId = useId();

	const commit = useCallback(
		(next: number) => {
			const clamped = clamp(next, min, max);
			if (size === undefined) setUncontrolled(clamped);
			onSizeChange?.(clamped);
		},
		[min, max, size, onSizeChange],
	);

	const onPointerMove = (event: React.PointerEvent<HTMLHRElement>) => {
		// Only while dragging: pointer capture is set on pointerdown and released
		// on pointerup, so this is the whole drag state machine.
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		const rect = rootRef.current?.getBoundingClientRect();
		if (!rect) return;
		const ratio =
			direction === "horizontal" ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
		commit(ratio * 100);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLHRElement>) => {
		const step = event.shiftKey ? 10 : 2;
		if (event.key === axis.decrease) commit(current - step);
		else if (event.key === axis.increase) commit(current + step);
		else if (event.key === "Home") commit(min);
		else if (event.key === "End") commit(max);
		else return;
		// Only swallow the keys we actually handled, so Tab and Escape still work.
		event.preventDefault();
	};

	return (
		<div ref={rootRef} className={cn("flex min-h-0 min-w-0", axis.root, className)} {...props}>
			<div id={firstId} className="min-h-0 min-w-0 overflow-auto" style={{ flexBasis: `${current}%` }}>
				{first}
			</div>
			{/* `<hr>` because separator is its implicit role — a focusable one, given
			    tabIndex and the aria-value* trio. It is void, so the grip is a
			    border rather than a child element. */}
			<hr
				tabIndex={0}
				aria-label={label}
				aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
				aria-valuenow={Math.round(current)}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-controls={firstId}
				onKeyDown={onKeyDown}
				onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
				onPointerMove={onPointerMove}
				onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
				className={cn(
					"focus-ring m-0 shrink-0 touch-none border-0 bg-line transition-colors hover:bg-line-bright",
					axis.handle,
				)}
			/>
			<div className="min-h-0 min-w-0 flex-1 overflow-auto">{second}</div>
		</div>
	);
}
