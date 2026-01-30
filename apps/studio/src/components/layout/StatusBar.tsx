import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";

export function StatusBar() {
  const { status, activeStreams } = useConnectionStore();

  const statusConfig = {
    connected: { icon: Wifi, label: "Connected", className: "text-green-400" },
    connecting: { icon: Loader2, label: "Connecting...", className: "text-yellow-400 animate-spin" },
    disconnected: { icon: WifiOff, label: "Disconnected", className: "text-zinc-500" },
    error: { icon: WifiOff, label: "Connection error", className: "text-red-400" },
  };

  const { icon: Icon, label, className } = statusConfig[status];

  return (
    <div className="h-6 border-t border-zinc-800 bg-zinc-950 flex items-center px-3 text-[11px]">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("w-3 h-3", className)} />
        <span className="text-zinc-500">{label}</span>
      </div>
      {activeStreams > 0 && (
        <span className="ml-3 text-zinc-600">
          {activeStreams} active stream{activeStreams > 1 ? "s" : ""}
        </span>
      )}
      <div className="ml-auto text-zinc-600">Blok Studio v0.1.0</div>
    </div>
  );
}
