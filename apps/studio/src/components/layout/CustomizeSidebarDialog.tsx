import { useNavigationStore } from "@/stores/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface NavItem {
	id: string;
	label: string;
}

interface CustomizeSidebarDialogProps {
	items: NavItem[];
	trigger?: React.ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CustomizeSidebarDialog({ items, trigger, open, onOpenChange }: CustomizeSidebarDialogProps) {
	const navOrder = useNavigationStore((s) => s.navOrder);
	const setNavOrder = useNavigationStore((s) => s.setNavOrder);

	const sortedItems = useMemo(
		() =>
			[...items].sort((a, b) => {
				const idxA = navOrder.indexOf(a.id);
				const idxB = navOrder.indexOf(b.id);
				if (idxA === -1 && idxB === -1) return 0;
				if (idxA === -1) return 1;
				if (idxB === -1) return -1;
				return idxA - idxB;
			}),
		[items, navOrder],
	);

	const [currentOrder, setCurrentOrder] = useState<NavItem[]>(sortedItems);

	useEffect(() => {
		setCurrentOrder(sortedItems);
	}, [sortedItems]);

	const handleMoveUp = (index: number) => {
		if (index === 0) return;
		const newOrder = [...currentOrder];
		const temp = newOrder[index];
		newOrder[index] = newOrder[index - 1] as NavItem;
		newOrder[index - 1] = temp as NavItem;
		setCurrentOrder(newOrder);
	};

	const handleMoveDown = (index: number) => {
		if (index === currentOrder.length - 1) return;
		const newOrder = [...currentOrder];
		const temp = newOrder[index];
		newOrder[index] = newOrder[index + 1] as NavItem;
		newOrder[index + 1] = temp as NavItem;
		setCurrentOrder(newOrder);
	};

	const handleSave = () => {
		setNavOrder(currentOrder.map((item) => item.id));
		onOpenChange(false);
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			{trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
			<Dialog.Portal>
				<Dialog.Overlay className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in" />
				<Dialog.Content className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-zinc-800 bg-canvas p-6 shadow-lg duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in">
					<div className="flex flex-col space-y-1.5 text-left">
						<Dialog.Title className="text-lg font-semibold leading-none tracking-tight text-zinc-100">
							Customize Navigation
						</Dialog.Title>
						<Dialog.Description className="text-sm text-zinc-400">
							Reorder the items in your main navigation menu.
						</Dialog.Description>
					</div>

					<div className="space-y-2 py-4">
						{currentOrder.map((item, index) => (
							<div key={item.id} className="bg-surface flex items-center gap-2 rounded-md border border-zinc-800 p-2">
								<GripVertical className="h-4 w-4 text-zinc-600" />
								<span className="flex-1 text-sm text-zinc-200">{item.label}</span>
								<div className="flex flex-col rounded border border-zinc-800">
									<button
										type="button"
										onClick={() => handleMoveUp(index)}
										disabled={index === 0}
										className="hover:bg-hover border-b border-zinc-800 p-1 disabled:cursor-not-allowed disabled:opacity-50"
									>
										<ChevronUp className="h-3 w-3" />
									</button>
									<button
										type="button"
										onClick={() => handleMoveDown(index)}
										disabled={index === currentOrder.length - 1}
										className="hover:bg-hover p-1 disabled:cursor-not-allowed disabled:opacity-50"
									>
										<ChevronDown className="h-3 w-3" />
									</button>
								</div>
							</div>
						))}
					</div>

					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Dialog.Close asChild>
							<button
								type="button"
								className="hover:bg-hover focus-visible:ring-ring inline-flex h-9 items-center justify-center rounded-md border border-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50"
							>
								Cancel
							</button>
						</Dialog.Close>
						<button
							type="button"
							onClick={handleSave}
							className="focus-visible:ring-ring inline-flex h-9 items-center justify-center rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50"
						>
							Save Changes
						</button>
					</div>

					<Dialog.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
						<X className="h-4 w-4" />
						<span className="sr-only">Close</span>
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
