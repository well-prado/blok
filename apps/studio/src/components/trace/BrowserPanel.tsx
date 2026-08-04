import { cn } from "@/lib/utils";
import type { BrowserArtifact, RunDetail, RunEvent } from "@/types";
import { CheckCircle2, Globe2, Loader2, Monitor, MousePointerClick, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface BrowserPanelProps {
	session: NonNullable<RunDetail["browserSession"]>;
	events: RunEvent[];
	selectedArtifact?: BrowserArtifact;
	onShowLive?: () => void;
	className?: string;
}

interface FrameMeta {
	frameId: number;
	width: number;
	height: number;
}

interface ActionPayload {
	action?: string;
	phase?: "running" | "completed" | "failed";
	locator?: Record<string, unknown>;
	box?: { x: number; y: number; width: number; height: number };
	error?: string;
}

export function BrowserPanel({ session, events, selectedArtifact, onShowLive, className }: BrowserPanelProps) {
	const [frameUrl, setFrameUrl] = useState("");
	const [frame, setFrame] = useState<FrameMeta>();
	const [connection, setConnection] = useState<"connecting" | "live" | "closed" | "error">("connecting");

	useEffect(() => {
		if (session.status !== "live") {
			setConnection("closed");
			return;
		}
		const stream = new URL(session.stream, window.location.origin);
		stream.protocol = stream.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(stream);
		socket.binaryType = "blob";
		let pending: FrameMeta | undefined;
		socket.onopen = () => setConnection("live");
		socket.onmessage = (message) => {
			if (typeof message.data === "string") {
				try {
					const value = JSON.parse(message.data) as FrameMeta & { type?: string };
					if (value.type === "frame") pending = value;
				} catch {
					// Ignore malformed stream metadata; the next complete frame can recover.
				}
				return;
			}
			if (!pending) return;
			const next = URL.createObjectURL(message.data as Blob);
			setFrameUrl((previous) => {
				if (previous) URL.revokeObjectURL(previous);
				return next;
			});
			setFrame(pending);
			socket.send(JSON.stringify({ type: "ack", frameId: pending.frameId }));
			pending = undefined;
		};
		socket.onerror = () => setConnection("error");
		socket.onclose = () => setConnection((current) => (current === "error" ? current : "closed"));
		return () => socket.close();
	}, [session.status, session.stream]);

	useEffect(
		() => () => {
			if (frameUrl) URL.revokeObjectURL(frameUrl);
		},
		[frameUrl],
	);

	const actions = useMemo(() => events.filter((event) => event.type === "BROWSER_ACTION").slice(-8), [events]);
	const currentAction = actions.at(-1)?.payload as ActionPayload | undefined;
	const box = currentAction?.box;
	const displayUrl = selectedArtifact?.url || frameUrl;

	return (
		<section className={cn("flex min-h-0 flex-col overflow-hidden bg-zinc-950", className)} aria-label="Live browser">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
				<Monitor className="h-4 w-4 text-cyan-300" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-xs font-semibold text-zinc-200">{selectedArtifact?.name || "Browser"}</div>
					<div className="flex items-center gap-1 truncate text-[10px] text-zinc-500">
						<Globe2 className="h-2.5 w-2.5 shrink-0" /> {session.url || "about:blank"}
					</div>
				</div>
				{selectedArtifact ? (
					<button
						type="button"
						onClick={onShowLive}
						className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300 hover:bg-cyan-400/20"
					>
						Show live
					</button>
				) : (
					<span
						className={cn(
							"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize",
							connection === "live" && "bg-cyan-400/10 text-cyan-300",
							connection === "connecting" && "bg-blue-400/10 text-blue-300",
							connection === "closed" && "bg-zinc-500/10 text-zinc-400",
							connection === "error" && "bg-red-400/10 text-red-300",
						)}
					>
						{connection === "connecting" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
						{connection}
					</span>
				)}
			</header>

			<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
				{displayUrl ? (
					<div
						className="relative max-h-full max-w-full overflow-hidden"
						style={{
							aspectRatio: !selectedArtifact && frame ? `${frame.width} / ${frame.height}` : "16 / 9",
							width: "100%",
						}}
					>
						<img
							src={displayUrl}
							alt={selectedArtifact ? `Browser artifact: ${selectedArtifact.name}` : "Live browser frame"}
							className="absolute inset-0 h-full w-full object-contain"
						/>
						{!selectedArtifact && box && frame && (
							<div
								className="pointer-events-none absolute border-2 border-cyan-300 bg-cyan-300/10 shadow-[0_0_14px_rgba(103,232,249,0.5)]"
								style={{
									left: `${(box.x / frame.width) * 100}%`,
									top: `${(box.y / frame.height) * 100}%`,
									width: `${(box.width / frame.width) * 100}%`,
									height: `${(box.height / frame.height) * 100}%`,
								}}
							>
								<MousePointerClick className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-cyan-200 drop-shadow" />
								{currentAction?.action === "click" && (
									<span className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-cyan-200" />
								)}
							</div>
						)}
					</div>
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
						<Monitor className="h-10 w-10" />
						<span className="text-xs">Waiting for the first browser frame…</span>
					</div>
				)}
			</div>

			<div className="max-h-36 shrink-0 overflow-y-auto border-t border-zinc-800 bg-zinc-950/95 p-2">
				<div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Browser activity</div>
				{actions.length === 0 ? (
					<div className="px-1 py-2 text-[10px] text-zinc-600">Actions will appear here as the workflow runs.</div>
				) : (
					<div className="space-y-1">
						{actions.map((event) => {
							const action = event.payload as ActionPayload;
							return (
								<div key={event.id} className="flex items-center gap-2 rounded bg-zinc-900 px-2 py-1.5 text-[10px]">
									{action.phase === "running" ? (
										<Loader2 className="h-3 w-3 animate-spin text-blue-300" />
									) : action.phase === "failed" ? (
										<XCircle className="h-3 w-3 text-red-400" />
									) : (
										<CheckCircle2 className="h-3 w-3 text-green-400" />
									)}
									<MousePointerClick className="h-3 w-3 text-zinc-500" />
									<span className="font-medium capitalize text-zinc-300">{action.action || "action"}</span>
									<span className="min-w-0 truncate text-zinc-500">{formatLocator(action.locator)}</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</section>
	);
}

function formatLocator(locator?: Record<string, unknown>): string {
	if (!locator) return "";
	return Object.entries(locator)
		.filter(([, value]) => typeof value === "string" || typeof value === "number")
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" · ");
}
