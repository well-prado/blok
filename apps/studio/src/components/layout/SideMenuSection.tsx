interface SideMenuSectionProps {
	title: string;
	children: React.ReactNode;
	isCollapsed?: boolean;
	action?: React.ReactNode;
}

export function SideMenuSection({ title, children, isCollapsed, action }: SideMenuSectionProps) {
	if (isCollapsed) {
		return (
			<div className="mt-6 flex flex-col gap-0.5">
				<div className="mb-1 flex w-full justify-center">
					<div className="h-[1px] w-4 bg-zinc-800" />
				</div>
				{children}
			</div>
		);
	}

	return (
		<div className="mt-6">
			<div className="mb-1 flex items-center justify-between px-2.5">
				<h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">{title}</h3>
				{action && <div>{action}</div>}
			</div>
			<div className="space-y-0.5">{children}</div>
		</div>
	);
}
