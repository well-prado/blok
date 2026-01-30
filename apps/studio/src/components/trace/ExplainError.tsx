import { useState } from "react";
import { Sparkles, Loader2, X, AlertCircle } from "lucide-react";
import { explainRunError } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ExplainErrorProps {
  runId: string;
  nodeId?: string;
  /** Compact mode for inline use in NodeDetail panel */
  compact?: boolean;
}

export function ExplainError({ runId, nodeId, compact }: ExplainErrorProps) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [explanation, setExplanation] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  const handleExplain = async () => {
    setState("loading");
    setErrorMsg("");
    try {
      const result = await explainRunError(runId, nodeId);
      setExplanation(result.explanation);
      setModel(result.model);
      setState("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to get explanation");
      setState("error");
    }
  };

  const handleClose = () => {
    setState("idle");
    setExplanation("");
    setModel("");
    setErrorMsg("");
  };

  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={handleExplain}
        className={cn(
          "flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors",
          compact
            ? "px-2 py-1 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30"
            : "px-2.5 py-1 bg-zinc-800 text-purple-400 hover:bg-zinc-700 hover:text-purple-300",
        )}
        title="Explain this error using AI"
      >
        <Sparkles className="w-3 h-3" />
        Explain Error
      </button>
    );
  }

  if (state === "loading") {
    return (
      <div className={cn(
        "flex items-center gap-2 text-xs text-purple-400",
        compact ? "px-2 py-1" : "px-2.5 py-1",
      )}>
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>Analyzing error...</span>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className={cn("space-y-2", compact ? "" : "mt-2")}>
        <div className="flex items-center gap-2 rounded-md border border-amber-900/50 bg-amber-950/30 px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span className="text-xs text-amber-300">{errorMsg}</span>
          <button
            type="button"
            onClick={handleClose}
            className="ml-auto p-0.5 text-amber-500 hover:text-amber-300"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        <button
          type="button"
          onClick={handleExplain}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 transition-colors"
        >
          <Sparkles className="w-3 h-3" />
          Try Again
        </button>
      </div>
    );
  }

  // state === "done"
  return (
    <div className={cn(
      "rounded-md border border-purple-900/50 bg-purple-950/20",
      compact ? "mt-2" : "mt-3",
    )}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-purple-900/30">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3 h-3 text-purple-400" />
          <span className="text-xs font-medium text-purple-300">AI Explanation</span>
          <span className="text-[10px] text-purple-500">({model})</span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="p-0.5 text-purple-500 hover:text-purple-300 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="p-3 text-xs text-zinc-300 leading-relaxed prose-invert max-h-80 overflow-y-auto">
        <MarkdownContent content={explanation} />
      </div>
    </div>
  );
}

/** Simple markdown renderer for the explanation content */
function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={i} className="text-sm font-semibold text-zinc-200 mt-3 mb-1">
          {line.slice(4)}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h3 key={i} className="text-sm font-bold text-zinc-100 mt-3 mb-1">
          {line.slice(3)}
        </h3>,
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h2 key={i} className="text-base font-bold text-zinc-100 mt-3 mb-1">
          {line.slice(2)}
        </h2>,
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <li key={i} className="ml-4 list-disc text-zinc-300">
          <InlineMarkdown text={line.slice(2)} />
        </li>,
      );
    } else if (/^\d+\.\s/.test(line)) {
      const text = line.replace(/^\d+\.\s/, "");
      elements.push(
        <li key={i} className="ml-4 list-decimal text-zinc-300">
          <InlineMarkdown text={text} />
        </li>,
      );
    } else if (line.startsWith("```")) {
      // Collect code block
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]?.startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      elements.push(
        <pre key={i} className="bg-zinc-900 rounded p-2 my-1 text-[11px] font-mono text-zinc-300 overflow-x-auto">
          {codeLines.join("\n")}
        </pre>,
      );
    } else if (line.trim() === "") {
      elements.push(<br key={i} />);
    } else {
      elements.push(
        <p key={i} className="text-zinc-300 my-0.5">
          <InlineMarkdown text={line} />
        </p>,
      );
    }
  }

  return <>{elements}</>;
}

/** Render inline markdown: **bold** and `code` */
function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} className="font-semibold text-zinc-200">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={i} className="bg-zinc-800 rounded px-1 py-0.5 text-[11px] font-mono text-purple-300">{part.slice(1, -1)}</code>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
