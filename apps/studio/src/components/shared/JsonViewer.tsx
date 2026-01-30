import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface JsonViewerProps {
  data: unknown;
  defaultExpanded?: boolean;
  maxDepth?: number;
  className?: string;
}

export function JsonViewer({ data, defaultExpanded = true, maxDepth = 5, className }: JsonViewerProps) {
  const formatted = useMemo(() => data, [data]);

  if (data === undefined || data === null) {
    return <span className="text-zinc-500 italic text-sm">null</span>;
  }

  return (
    <div className={cn("font-mono text-xs", className)}>
      <div className="flex items-center justify-end mb-1">
        <CopyButton text={JSON.stringify(data, null, 2)} />
      </div>
      <JsonNode value={formatted} depth={0} expanded={defaultExpanded} maxDepth={maxDepth} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function JsonNode({
  value,
  depth,
  expanded: defaultExpanded,
  maxDepth,
  keyName,
}: {
  value: unknown;
  depth: number;
  expanded: boolean;
  maxDepth: number;
  keyName?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded && depth < maxDepth);

  if (value === null) return <JsonPrimitive keyName={keyName} value="null" className="text-zinc-500" />;
  if (value === undefined) return <JsonPrimitive keyName={keyName} value="undefined" className="text-zinc-500" />;

  if (typeof value === "string") {
    const display = value.length > 200 ? value.slice(0, 200) + "\u2026" : value;
    return <JsonPrimitive keyName={keyName} value={`"${display}"`} className="text-green-400" />;
  }

  if (typeof value === "number") return <JsonPrimitive keyName={keyName} value={String(value)} className="text-blue-400" />;
  if (typeof value === "boolean") return <JsonPrimitive keyName={keyName} value={String(value)} className="text-amber-400" />;

  if (Array.isArray(value)) {
    if (value.length === 0) return <JsonPrimitive keyName={keyName} value="[]" className="text-zinc-400" />;
    return (
      <JsonCollapsible
        keyName={keyName}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        bracket={["[", "]"]}
        count={value.length}
      >
        {value.map((item, i) => (
          <div key={i} className="ml-4">
            <JsonNode value={item} depth={depth + 1} expanded={defaultExpanded} maxDepth={maxDepth} />
            {i < value.length - 1 && <span className="text-zinc-600">,</span>}
          </div>
        ))}
      </JsonCollapsible>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <JsonPrimitive keyName={keyName} value="{}" className="text-zinc-400" />;
    return (
      <JsonCollapsible
        keyName={keyName}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        bracket={["{", "}"]}
        count={entries.length}
      >
        {entries.map(([k, v], i) => (
          <div key={k} className="ml-4">
            <JsonNode value={v} depth={depth + 1} expanded={defaultExpanded} maxDepth={maxDepth} keyName={k} />
            {i < entries.length - 1 && <span className="text-zinc-600">,</span>}
          </div>
        ))}
      </JsonCollapsible>
    );
  }

  return <JsonPrimitive keyName={keyName} value={String(value)} className="text-zinc-400" />;
}

function JsonPrimitive({ keyName, value, className }: { keyName?: string; value: string; className?: string }) {
  return (
    <span>
      {keyName !== undefined && (
        <>
          <span className="text-purple-400">"{keyName}"</span>
          <span className="text-zinc-500">: </span>
        </>
      )}
      <span className={className}>{value}</span>
    </span>
  );
}

function JsonCollapsible({
  keyName,
  expanded,
  onToggle,
  bracket,
  count,
  children,
}: {
  keyName?: string;
  expanded: boolean;
  onToggle: () => void;
  bracket: [string, string];
  count: number;
  children: React.ReactNode;
}) {
  return (
    <span>
      {keyName !== undefined && (
        <>
          <span className="text-purple-400">"{keyName}"</span>
          <span className="text-zinc-500">: </span>
        </>
      )}
      <button onClick={onToggle} className="inline-flex items-center hover:text-zinc-300 text-zinc-500">
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="text-zinc-400">{bracket[0]}</span>
      </button>
      {expanded ? (
        <>
          <div>{children}</div>
          <span className="text-zinc-400">{bracket[1]}</span>
        </>
      ) : (
        <span className="text-zinc-600 text-xs"> {count} items {bracket[1]}</span>
      )}
    </span>
  );
}
