import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

export interface BreadcrumbSegment {
	label: string;
	to?: string;
	params?: Record<string, string>;
}

interface BreadcrumbsProps {
	segments: BreadcrumbSegment[];
	className?: string;
}

export function Breadcrumbs({ segments, className }: BreadcrumbsProps) {
	if (!segments || segments.length === 0) return null;

	return (
		<nav aria-label="Breadcrumb" className={cn("flex items-center gap-1.5 text-sm text-zinc-500", className)}>
			{segments.map((segment, index) => {
				const isLast = index === segments.length - 1;
				return (
					<div key={`${segment.label}-${index}`} className="flex items-center gap-1.5">
						{segment.to ? (
							<Link to={segment.to} params={segment.params} className="hover:text-zinc-300 transition-colors">
								{segment.label}
							</Link>
						) : (
							<span className={cn(isLast && "text-zinc-300")}>{segment.label}</span>
						)}
						{!isLast && <ChevronRight className="w-3.5 h-3.5 text-zinc-600" />}
					</div>
				);
			})}
		</nav>
	);
}
