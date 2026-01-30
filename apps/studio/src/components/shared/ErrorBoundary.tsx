import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error("[ErrorBoundary]", error, errorInfo);
	}

	handleRetry = () => {
		this.setState({ hasError: false, error: null });
	};

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<div className="flex flex-col items-center justify-center h-full min-h-[200px] gap-4 p-8">
					<div className="flex items-center gap-2 text-amber-400">
						<AlertTriangle className="w-6 h-6" />
						<h2 className="text-lg font-semibold">Something went wrong</h2>
					</div>
					<p className="text-sm text-zinc-400 text-center max-w-md">
						{this.state.error?.message || "An unexpected error occurred while rendering this component."}
					</p>
					<button
						type="button"
						onClick={this.handleRetry}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors border border-zinc-700"
					>
						<RefreshCw className="w-3.5 h-3.5" />
						Retry
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}
