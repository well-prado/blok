import { JsonViewer } from "@/components/shared/JsonViewer";
import { sendWorkflowRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, ChevronRight, Copy, Loader2, Send, X } from "lucide-react";
import { useState } from "react";

interface RequestBuilderProps {
	defaultMethod?: string;
	defaultPath?: string;
	defaultBody?: string;
	defaultHeaders?: Record<string, string>;
	onClose: () => void;
	onRequestSent?: () => void;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const METHOD_COLORS: Record<string, string> = {
	GET: "text-green-400",
	POST: "text-blue-400",
	PUT: "text-amber-400",
	PATCH: "text-orange-400",
	DELETE: "text-red-400",
};

export function RequestBuilder({
	defaultMethod = "GET",
	defaultPath = "/",
	defaultBody = "",
	defaultHeaders,
	onClose,
	onRequestSent,
}: RequestBuilderProps) {
	const [method, setMethod] = useState(defaultMethod.toUpperCase());
	const [path, setPath] = useState(defaultPath);
	const [body, setBody] = useState(defaultBody);
	const [headersStr, setHeadersStr] = useState(defaultHeaders ? JSON.stringify(defaultHeaders, null, 2) : "{}");
	const [sending, setSending] = useState(false);
	const [response, setResponse] = useState<{
		status: number;
		headers: Record<string, string>;
		body: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showHeaders, setShowHeaders] = useState(false);
	const [showResponseHeaders, setShowResponseHeaders] = useState(false);
	const [copied, setCopied] = useState(false);

	const handleSend = async () => {
		setSending(true);
		setError(null);
		setResponse(null);

		try {
			let headers: Record<string, string> = {};
			try {
				headers = JSON.parse(headersStr);
			} catch {
				// ignore header parse errors
			}

			const res = await sendWorkflowRequest({
				method,
				path,
				headers,
				body: method !== "GET" && method !== "HEAD" ? body : undefined,
			});

			setResponse(res);
			onRequestSent?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Request failed");
		} finally {
			setSending(false);
		}
	};

	const copyResponse = () => {
		if (response) {
			navigator.clipboard.writeText(response.body);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const statusColor =
		response && response.status >= 200 && response.status < 300
			? "text-green-400"
			: response && response.status >= 400
				? "text-red-400"
				: "text-amber-400";

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
				<h3 className="text-sm font-medium text-zinc-200">Request Builder</h3>
				<button type="button" onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors" aria-label="Close">
					<X className="w-4 h-4" />
				</button>
			</div>

			{/* Request form */}
			<div className="flex-1 overflow-y-auto p-4 space-y-3">
				{/* Method + Path */}
				<div className="flex gap-2">
					<select
						value={method}
						onChange={(e) => setMethod(e.target.value)}
						className={cn(
							"bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-sm font-mono outline-none",
							METHOD_COLORS[method] || "text-zinc-300",
						)}
					>
						{HTTP_METHODS.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
					<input
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/api/endpoint"
						className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm font-mono text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-600"
					/>
					<button
						type="button"
						onClick={handleSend}
						disabled={sending || !path}
						className={cn(
							"flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
							sending ? "bg-zinc-700 text-zinc-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-500",
						)}
					>
						{sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
						Send
					</button>
				</div>

				{/* Headers (collapsible) */}
				<div>
					<button
						type="button"
						onClick={() => setShowHeaders(!showHeaders)}
						className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
						aria-expanded={showHeaders}
					>
						{showHeaders ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
						Headers (JSON)
					</button>
					{showHeaders && (
						<textarea
							value={headersStr}
							onChange={(e) => setHeadersStr(e.target.value)}
							rows={4}
							className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-500 outline-none focus:border-zinc-600 resize-y"
							placeholder='{"Authorization": "Bearer ..."}'
						/>
					)}
				</div>

				{/* Body (for non-GET methods) */}
				{method !== "GET" && method !== "HEAD" && (
					<div>
						<label htmlFor="request-body" className="text-xs text-zinc-400 mb-1 block">
							Body (JSON)
						</label>
						<textarea
							id="request-body"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							rows={6}
							className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-500 outline-none focus:border-zinc-600 resize-y"
							placeholder='{"key": "value"}'
						/>
					</div>
				)}

				{/* Error */}
				{error && (
					<div className="bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 text-xs text-red-400">
						{error}
					</div>
				)}

				{/* Response */}
				{response && (
					<div className="border border-zinc-700 rounded-md overflow-hidden">
						<div className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 border-b border-zinc-700">
							<div className="flex items-center gap-2">
								<span className="text-xs text-zinc-400">Response</span>
								<span className={cn("text-sm font-mono font-medium", statusColor)}>{response.status}</span>
							</div>
							<button
								type="button"
								onClick={copyResponse}
								className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
								title="Copy response body"
							aria-label="Copy response body"
							>
								{copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
							</button>
						</div>

						{/* Response headers (collapsible) */}
						<div className="border-b border-zinc-800">
							<button
								type="button"
								onClick={() => setShowResponseHeaders(!showResponseHeaders)}
								className="flex items-center gap-1 px-3 py-1.5 text-[10px] text-zinc-500 hover:text-zinc-400 w-full text-left"
								aria-expanded={showResponseHeaders}
							>
								{showResponseHeaders ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
								Headers ({Object.keys(response.headers).length})
							</button>
							{showResponseHeaders && (
								<div className="px-3 pb-2">
									{Object.entries(response.headers).map(([key, value]) => (
										<div key={key} className="text-[10px] font-mono">
											<span className="text-zinc-500">{key}: </span>
											<span className="text-zinc-400">{value}</span>
										</div>
									))}
								</div>
							)}
						</div>

						{/* Response body */}
						<div className="p-3 max-h-64 overflow-y-auto">
							{tryParseJson(response.body) ? (
								<JsonViewer data={tryParseJson(response.body)} maxDepth={6} />
							) : (
								<pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap break-all">{response.body}</pre>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function tryParseJson(str: string): unknown {
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}
